import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AffectedSheet,
  CodeRevision,
  PendingItem,
  RelationSnapshot,
  RevisionBlock,
  RevisionNotice,
  RevisionPrecheck,
} from '../types/codeRevision'
import type { Sheet } from '../types/sheet'
import { createId, db, plain } from '../utils/db'
import { useSheetStore } from './sheetStore'

export interface PrecheckInput {
  sheetId: string
  newCode: string
}

export interface ApplyRevisionResult {
  ok: boolean
  revision?: CodeRevision
  precheck?: RevisionPrecheck
}

export interface PendingItemView extends PendingItem {
  revisionId: string
  oldCode: string
  newCode: string
}

function replaceCode(codes: string[], from: string, to: string): string[] {
  return codes.map((code) => (code === from ? to : code))
}

/**
 * 比对修订生效时保存的关系快照与当前库内状态：
 * 快照内任意图幅的邻接表与预期不符，即视为关联关系已被人工改动。
 * 修订后新增的邻接引用不在快照内，不视作漂移（撤销时一并还原其引用号）。
 */
export function detectRelationDrift(
  snapshot: RelationSnapshot,
  allSheets: Sheet[],
  oldCode: string,
  newCode: string,
): boolean {
  const target = allSheets.find((sheet) => sheet.id === snapshot.targetId)
  if (!target) {
    return true
  }
  const expectedTarget = replaceCode(snapshot.targetNeighborCodes, oldCode, newCode)
  if (JSON.stringify(target.neighborCodes) !== JSON.stringify(expectedTarget)) {
    return true
  }
  return Object.entries(snapshot.referrers).some(([referrerId, codes]) => {
    const referrer = allSheets.find((sheet) => sheet.id === referrerId)
    if (!referrer) {
      return true
    }
    const expected = replaceCode(codes, oldCode, newCode)
    return JSON.stringify(referrer.neighborCodes) !== JSON.stringify(expected)
  })
}

/**
 * 纯函数预检：不写库。基于调用方给出的当前图幅集合判定可否修订，
 * 并汇总受影响图幅、待处理记录草稿与冲突提示。
 */
export function buildPrecheck(
  allSheets: Sheet[],
  input: PrecheckInput,
  priorRevision?: CodeRevision,
): RevisionPrecheck {
  const blocks: RevisionBlock[] = []
  const notices: RevisionNotice[] = []
  const newCode = input.newCode.trim()
  const target = allSheets.find((sheet) => sheet.id === input.sheetId)

  if (!target) {
    blocks.push({ code: 'target-missing', message: '未找到需要修订编号的图幅，请刷新后重试。' })
  }
  if (!newCode) {
    blocks.push({ code: 'new-code-required', message: '请填写新图幅号。' })
  }
  if (target && newCode && target.code === newCode) {
    blocks.push({ code: 'new-code-same', message: '新图幅号与当前图幅号相同，无需修订。' })
  }
  if (target && newCode && target.code !== newCode) {
    const occupant = allSheets.find((sheet) => sheet.id !== target.id && sheet.code === newCode)
    if (occupant) {
      blocks.push({
        code: 'new-code-occupied',
        message: `新图幅号「${newCode}」已被图幅《${occupant.title}》占用，不能重复编号。`,
      })
    }
  }

  const oldCode = target?.code ?? ''
  const referrers = target
    ? allSheets.filter((sheet) => sheet.id !== target.id && sheet.neighborCodes.includes(oldCode))
    : []
  // 邻接表中已预留新号但尚无图幅卡（缺编）的情况，换号后会变成重号引用。
  const vacantNewCodeReferrerIds = allSheets
    .filter(
      (sheet) =>
        sheet.id !== target?.id &&
        !referrers.some((referrer) => referrer.id === sheet.id) &&
        sheet.neighborCodes.includes(newCode),
    )
    .map((sheet) => sheet.id)

  if (priorRevision && target) {
    const drifted = detectRelationDrift(
      priorRevision.relationSnapshot,
      allSheets,
      priorRevision.oldCode,
      priorRevision.newCode,
    )
    if (drifted) {
      blocks.push({
        code: 'relation-changed',
        message:
          `自 ${priorRevision.newCode} 生效以来关联关系已发生变化（邻接表被人工改动），` +
          '为避免覆盖新的整理成果，本次修订不写入；请核对邻接关系后重试。',
      })
    }
  }

  const affectedSheets: AffectedSheet[] = []
  const pendingItems: PendingItem[] = []
  if (target) {
    affectedSheets.push({
      sheetId: target.id,
      codeBefore: target.code,
      codeAfter: newCode || target.code,
      catalogued: target.status === '已编',
    })
    if (target.status === '已编') {
      notices.push({
        code: 'target-catalogued',
        message: `本图幅为已编图幅，换号后将留下待处理记录，请核改扫描件标注、地名对照与导出资料。`,
      })
      pendingItems.push({
        id: createId('pending'),
        kind: 'target',
        sheetId: target.id,
        sheetCode: newCode || target.code,
        description: '',
        resolved: false,
      })
    }
    if (target.neighborCodes.includes(target.code)) {
      notices.push({
        code: 'self-reference',
        message: '本图幅的邻接表中存在自引旧号，将一并改为新号。',
      })
    }
  }
  for (const referrer of referrers) {
    const directionIndex = referrer.neighborCodes.indexOf(oldCode)
    affectedSheets.push({
      sheetId: referrer.id,
      codeBefore: referrer.code,
      codeAfter: referrer.code,
      directionIndex,
      catalogued: referrer.status === '已编',
    })
    if (referrer.status === '已编') {
      notices.push({
        code: 'referrer-catalogued',
        message: `邻接图幅「${referrer.code}」为已编图幅，引用号同步改写后将留下待处理记录。`,
      })
      pendingItems.push({
        id: createId('pending'),
        kind: 'reference',
        sheetId: referrer.id,
        sheetCode: referrer.code,
        description: '',
        resolved: false,
      })
    }
  }
  if (vacantNewCodeReferrerIds.length) {
    const codes = vacantNewCodeReferrerIds
      .map((id) => allSheets.find((sheet) => sheet.id === id)?.code)
      .filter(Boolean)
      .join('、')
    notices.push({
      code: 'vacant-code-taken',
      message: `邻接表中「${codes}」已把新号「${newCode}」列为缺编图号，换号后该预留关系将指向本图幅，请核对四至。`,
    })
  }

  const snapshot: RelationSnapshot = target
    ? {
        targetId: target.id,
        targetNeighborCodes: [...target.neighborCodes],
        referrers: Object.fromEntries(
          referrers.map((referrer) => [referrer.id, [...referrer.neighborCodes]]),
        ),
      }
    : { targetId: input.sheetId, targetNeighborCodes: [], referrers: {} }

  return {
    blocked: blocks.length > 0,
    blocks,
    notices,
    affectedSheets,
    pendingItems,
    snapshot,
    referrerIds: referrers.map((sheet) => sheet.id),
    vacantNewCodeReferrerIds,
  }
}

export const useCodeRevisionStore = defineStore('codeRevision', () => {
  const revisions = ref<CodeRevision[]>([])
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      initialization = db.codeRevisions.toArray().then((rows) => {
        revisions.value = rows.sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))
        initialized.value = true
      })
    }
    await initialization
  }

  function getRevisionById(id: string): CodeRevision | undefined {
    return revisions.value.find((revision) => revision.id === id)
  }

  function revisionsForSheet(sheetId: string): CodeRevision[] {
    return revisions.value
      .filter((revision) => revision.sheetId === sheetId)
      .sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))
  }

  function latestActiveRevisionForSheet(sheetId: string): CodeRevision | undefined {
    return revisionsForSheet(sheetId).find((revision) => revision.status === 'active')
  }

  function latestActiveRevision(): CodeRevision | undefined {
    return revisions.value.find((revision) => revision.status === 'active')
  }

  async function precheckRevision(input: PrecheckInput): Promise<RevisionPrecheck> {
    await init()
    const allSheets = await db.sheets.toArray()
    const target = allSheets.find((sheet) => sheet.id === input.sheetId)
    const prior = target ? latestActiveRevisionForSheet(target.id) : undefined
    return buildPrecheck(allSheets, input, prior)
  }

  /**
   * 生效一次编号修订。事务内重新读取图幅并再次预检，
   * 存在冲突（新号被占用、关联关系变化等）则整次操作不写入。
   */
  async function applyRevision(input: {
    sheetId: string
    newCode: string
    reason: string
  }): Promise<ApplyRevisionResult> {
    await init()
    const reason = input.reason.trim()
    const result = await db.transaction(
      'rw',
      [db.sheets, db.codeRevisions],
      async (): Promise<ApplyRevisionResult> => {
        const allSheets = await db.sheets.toArray()
        const target = allSheets.find((sheet) => sheet.id === input.sheetId)
        const prior = target
          ? (await db.codeRevisions
              .where('sheetId').equals(target.id)
              .filter((revision) => revision.status === 'active')
              .sortBy('appliedAt'))
              .pop()
          : undefined
        const precheck = buildPrecheck(allSheets, input, prior)
        if (precheck.blocked || !target) {
          return { ok: false, precheck }
        }
        if (!reason) {
          return {
            ok: false,
            precheck: {
              ...precheck,
              blocked: true,
              blocks: [{ code: 'new-code-required', message: '请填写修订原因。' }],
            },
          }
        }

        const oldCode = target.code
        const newCode = input.newCode.trim()
        const now = new Date().toISOString()

        // 所有把旧号列为邻接的图幅（含被修订图幅自身的自引）一起换号。
        const affectedIds = new Set(precheck.affectedSheets.map((item) => item.sheetId))
        for (const sheet of allSheets) {
          if (sheet.id === target.id) {
            await db.sheets.update(sheet.id, { code: newCode })
          }
          if (affectedIds.has(sheet.id) || sheet.neighborCodes.includes(oldCode)) {
            const nextCodes = replaceCode(sheet.neighborCodes, oldCode, newCode)
            await db.sheets.update(sheet.id, { neighborCodes: nextCodes })
          }
        }

        const pendingItems: PendingItem[] = precheck.affectedSheets
          .filter((item) => item.catalogued)
          .map((item) => {
            const isTarget = item.sheetId === target.id
            return {
              id: createId('pending'),
              kind: isTarget ? ('target' as const) : ('reference' as const),
              sheetId: item.sheetId,
              sheetCode: isTarget ? newCode : item.codeAfter,
              description: isTarget
                ? `编号由 ${oldCode} 改为 ${newCode}，请核改扫描件标注、地名对照与导出资料中的旧号。`
                : `邻接关系引用的 ${oldCode} 已改为 ${newCode}，请复核接边标注与本地名资料。`,
              resolved: false,
            }
          })

        const revision: CodeRevision = {
          id: createId('rev'),
          status: 'active',
          sheetId: target.id,
          oldCode,
          newCode,
          reason,
          affectedSheets: precheck.affectedSheets.map((item) => ({
            ...item,
            codeAfter: item.sheetId === target.id ? newCode : item.codeAfter,
          })),
          pendingItems,
          relationSnapshot: precheck.snapshot,
          appliedAt: now,
        }
        await db.codeRevisions.add(plain(revision))
        return { ok: true, revision, precheck }
      },
    )

    if (result.ok && result.revision) {
      revisions.value = [result.revision, ...revisions.value]
      await useSheetStore().syncSheetsFromDb()
    }
    return result
  }

  /**
   * 撤销当前最近一次已生效修订。关系已变动或旧号已被重新占用时不写入。
   */
  async function undoRevision(revisionId: string): Promise<{ ok: boolean; blocks: RevisionBlock[] }> {
    await init()
    const outcome = await db.transaction(
      'rw',
      [db.sheets, db.codeRevisions],
      async (): Promise<{ ok: boolean; blocks: RevisionBlock[] }> => {
        const revision = await db.codeRevisions.get(revisionId)
        if (!revision) {
          return { ok: false, blocks: [{ code: 'target-missing', message: '修订记录不存在。' }] }
        }
        if (revision.status !== 'active') {
          return { ok: false, blocks: [{ code: 'not-latest', message: '该修订此前已撤销，不能重复撤销。' }] }
        }
        const latestActive = await db.codeRevisions
          .where('status').equals('active')
          .sortBy('appliedAt')
        const newest = latestActive[latestActive.length - 1]
        if (!newest || newest.id !== revision.id) {
          return {
            ok: false,
            blocks: [
              {
                code: 'not-latest',
                message: '该修订之后已有更新的修订生效，请先撤销更近的一次修订。',
              },
            ],
          }
        }

        const allSheets = await db.sheets.toArray()
        if (allSheets.some((sheet) => sheet.id !== revision.sheetId && sheet.code === revision.oldCode)) {
          return {
            ok: false,
            blocks: [
              {
                code: 'old-code-occupied',
                message: `旧号「${revision.oldCode}」已被其他图幅占用，无法还原，请先处理重号。`,
              },
            ],
          }
        }
        if (detectRelationDrift(revision.relationSnapshot, allSheets, revision.oldCode, revision.newCode)) {
          return {
            ok: false,
            blocks: [
              {
                code: 'relation-changed',
                message: '修订生效后关联关系已发生变化，为避免覆盖新的整理成果，本次撤销不写入。',
              },
            ],
          }
        }

        for (const sheet of allSheets) {
          if (sheet.id === revision.sheetId) {
            await db.sheets.update(sheet.id, { code: revision.oldCode })
          }
          if (sheet.neighborCodes.includes(revision.newCode)) {
            await db.sheets.update(sheet.id, {
              neighborCodes: replaceCode(sheet.neighborCodes, revision.newCode, revision.oldCode),
            })
          }
        }
        await db.codeRevisions.update(revision.id, {
          status: 'undone',
          undoneAt: new Date().toISOString(),
        })
        return { ok: true, blocks: [] }
      },
    )

    if (outcome.ok) {
      revisions.value = await db.codeRevisions.toArray()
      revisions.value.sort((left, right) => right.appliedAt.localeCompare(left.appliedAt))
      await useSheetStore().syncSheetsFromDb()
    }
    return outcome
  }

  async function resolvePendingItem(revisionId: string, itemId: string): Promise<void> {
    const revision = revisions.value.find((entry) => entry.id === revisionId)
    if (!revision || revision.status !== 'active') {
      return
    }
    const item = revision.pendingItems.find((pending) => pending.id === itemId)
    if (!item || item.resolved) {
      return
    }
    item.resolved = true
    item.resolvedAt = new Date().toISOString()
    await db.codeRevisions.update(revisionId, { pendingItems: plain(revision.pendingItems) })
  }

  /** 汇总每个被修订图幅“最近一次生效修订”中与某图幅相关的待处理记录。 */
  function pendingItemsForSheet(sheetId: string): PendingItemView[] {
    const byTarget = new Map<string, CodeRevision>()
    for (const revision of revisions.value) {
      if (revision.status !== 'active') {
        continue
      }
      const existing = byTarget.get(revision.sheetId)
      if (!existing || revision.appliedAt > existing.appliedAt) {
        byTarget.set(revision.sheetId, revision)
      }
    }
    const views: PendingItemView[] = []
    for (const revision of byTarget.values()) {
      for (const item of revision.pendingItems) {
        if (item.sheetId === sheetId && !item.resolved) {
          views.push({
            ...item,
            revisionId: revision.id,
            oldCode: revision.oldCode,
            newCode: revision.newCode,
          })
        }
      }
    }
    return views
  }

  const openPendingCount = computed(() => {
    const counts = new Map<string, number>()
    const byTarget = new Map<string, CodeRevision>()
    for (const revision of revisions.value) {
      if (revision.status !== 'active') {
        continue
      }
      const existing = byTarget.get(revision.sheetId)
      if (!existing || revision.appliedAt > existing.appliedAt) {
        byTarget.set(revision.sheetId, revision)
      }
    }
    for (const revision of byTarget.values()) {
      for (const item of revision.pendingItems) {
        if (!item.resolved) {
          counts.set(item.sheetId, (counts.get(item.sheetId) ?? 0) + 1)
        }
      }
    }
    return counts
  })

  return {
    revisions,
    initialized,
    init,
    getRevisionById,
    revisionsForSheet,
    latestActiveRevisionForSheet,
    latestActiveRevision,
    precheckRevision,
    applyRevision,
    undoRevision,
    resolvePendingItem,
    pendingItemsForSheet,
    openPendingCount,
  }
})
