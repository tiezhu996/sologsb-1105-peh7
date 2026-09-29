import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import type { SheetRevision } from '../types/revision'
import { createId, db, plain } from '../utils/db'
import { sortByYear } from '../utils/scale'

export type NewSheet = Omit<Sheet, 'id' | 'neighborCodes'> & {
  neighborCodes?: string[]
}
export type NewScanItem = Omit<ScanItem, 'id'>

export interface RevisionResult {
  ok: boolean
  /** 未写入时的冲突原因，逐条列出 */
  conflicts: string[]
  revision?: SheetRevision
}

export interface ReviseSheetInput {
  sheetId: string
  newCode: string
  reason: string
  /** 预览时依据的旧号，用于提交前核对图号未被其他修订改动 */
  expectedOldCode: string
  /** 预览时列出的受影响图幅 ID，用于提交前核对邻接关系未发生变化 */
  expectedAffectedIds: string[]
}

export const useSheetStore = defineStore('sheet', () => {
  const sheets = ref<Sheet[]>([])
  const allScans = ref<ScanItem[]>([])
  const revisions = ref<SheetRevision[]>([])
  const currentSheet = ref<Sheet | null>(null)
  const loading = ref(false)
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const currentScans = computed(() =>
    currentSheet.value
      ? allScans.value.filter((scan) => scan.sheetId === currentSheet.value?.id)
      : [],
  )

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      loading.value = true
      initialization = Promise.all([
        db.sheets.toArray(),
        db.scans.toArray(),
        db.sheetRevisions.toArray(),
      ])
        .then(([sheetRows, scanRows, revisionRows]) => {
          sheets.value = sortByYear(sheetRows).reverse()
          allScans.value = scanRows
          revisions.value = revisionRows
          initialized.value = true
        })
        .finally(() => {
          loading.value = false
        })
    }
    await initialization
  }

  async function addSheet(input: NewSheet): Promise<Sheet> {
    await init()
    const sheet: Sheet = {
      ...input,
      id: createId('sheet'),
      neighborCodes: input.neighborCodes ?? [],
    }
    await db.sheets.add(plain(sheet))
    sheets.value = sortByYear([...sheets.value, sheet]).reverse()
    currentSheet.value = sheet
    return sheet
  }

  async function loadSheet(id: string): Promise<void> {
    await init()
    currentSheet.value = sheets.value.find((sheet) => sheet.id === id) ?? (await db.sheets.get(id)) ?? null
  }

  async function addScan(input: NewScanItem): Promise<ScanItem> {
    await init()
    const scan: ScanItem = { ...input, id: createId('scan') }
    if (scan.isPrimary) {
      await db.scans.where('sheetId').equals(scan.sheetId).modify({ isPrimary: false })
      allScans.value = allScans.value.map((item) =>
        item.sheetId === scan.sheetId ? { ...item, isPrimary: false } : item,
      )
    }
    await db.scans.add(plain(scan))
    allScans.value = [...allScans.value, scan]
    return scan
  }

  async function setPrimaryScan(scanId: string): Promise<void> {
    const target = allScans.value.find((scan) => scan.id === scanId)
    if (!target) {
      return
    }
    await db.scans.where('sheetId').equals(target.sheetId).modify({ isPrimary: false })
    await db.scans.update(scanId, { isPrimary: true })
    allScans.value = allScans.value.map((scan) => {
      if (scan.sheetId !== target.sheetId) {
        return scan
      }
      return { ...scan, isPrimary: scan.id === scanId }
    })
  }

  function getSheetById(id: string): Sheet | undefined {
    return sheets.value.find((sheet) => sheet.id === id)
  }

  function getSheetByCode(code: string): Sheet | undefined {
    return sheets.value.find((sheet) => sheet.code === code)
  }

  function getScansForSheet(sheetId: string): ScanItem[] {
    return allScans.value
      .filter((scan) => scan.sheetId === sheetId)
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
  }

  function getRevisionsForSheet(sheetId: string): SheetRevision[] {
    return revisions.value
      .filter((revision) => revision.sheetId === sheetId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  function getLatestEffectiveRevision(sheetId: string): SheetRevision | undefined {
    return getRevisionsForSheet(sheetId).find((revision) => revision.status === '已生效')
  }

  /** 把邻接图号中的 oldCode 替换为 newCode；若已含新号则仅删除旧号，避免重复登记。 */
  function replaceNeighborCode(codes: string[], oldCode: string, newCode: string): string[] {
    if (codes.includes(newCode)) {
      return codes.filter((code) => code !== oldCode)
    }
    return codes.map((code) => (code === oldCode ? newCode : code))
  }

  async function reviseSheetCode(input: ReviseSheetInput): Promise<RevisionResult> {
    await init()
    const source = sheets.value.find((sheet) => sheet.id === input.sheetId)
    if (!source) {
      return { ok: false, conflicts: ['未找到该图幅卡，可能已被移除。'] }
    }

    const oldCode = source.code
    const newCode = input.newCode.trim()
    const reason = input.reason.trim()
    const conflicts: string[] = []

    if (!newCode) {
      conflicts.push('请填写新的图幅号。')
    }
    if (!reason) {
      conflicts.push('请填写换号原因，记入修订历史。')
    }
    if (newCode && newCode === oldCode) {
      conflicts.push('新号与现行图号相同，无需修订。')
    }
    if (newCode && source.neighborCodes.includes(newCode)) {
      conflicts.push(`新号「${newCode}」与本图幅登记的邻接图号相同，换号后会形成自邻接，请先调整邻接登记。`)
    }
    const occupied = newCode
      ? sheets.value.find((sheet) => sheet.id !== source.id && sheet.code === newCode)
      : undefined
    if (occupied) {
      conflicts.push(
        `新号「${newCode}」已被图幅《${occupied.title}》（${occupied.code}）占用，请改用其他图号。`,
      )
    }

    // 提交前核对：预览后图号或邻接关系若发生变化，本次不写入。
    if (input.expectedOldCode !== oldCode) {
      conflicts.push('该图幅号已被其他修订更改，请刷新后重新核对再提交。')
    }
    const affected = sheets.value.filter(
      (sheet) => sheet.id !== source.id && sheet.neighborCodes.includes(oldCode),
    )
    const currentAffectedIds = affected.map((sheet) => sheet.id).sort()
    const expectedIds = [...input.expectedAffectedIds].sort()
    if (
      currentAffectedIds.length !== expectedIds.length ||
      currentAffectedIds.some((id, index) => id !== expectedIds[index])
    ) {
      conflicts.push('邻接关系已发生变化：有图幅新增或解除了与本图幅的邻接登记，请刷新预览后重新提交。')
    }

    if (conflicts.length > 0) {
      return { ok: false, conflicts }
    }

    const revision: SheetRevision = {
      id: createId('rev'),
      sheetId: source.id,
      oldCode,
      newCode,
      reason,
      status: '已生效',
      affectedSheetIds: affected.map((sheet) => sheet.id),
      affectedSheetCodes: affected.map((sheet) => sheet.code),
      createdAt: new Date().toISOString(),
    }

    await db.transaction('rw', db.sheets, db.sheetRevisions, async () => {
      await db.sheets.update(source.id, { code: newCode })
      for (const sheet of affected) {
        await db.sheets.update(sheet.id, {
          neighborCodes: replaceNeighborCode(sheet.neighborCodes, oldCode, newCode),
        })
      }
      await db.sheetRevisions.add(plain(revision))
    })

    source.code = newCode
    for (const sheet of affected) {
      sheet.neighborCodes = replaceNeighborCode(sheet.neighborCodes, oldCode, newCode)
    }
    revisions.value = [...revisions.value, revision]

    return { ok: true, conflicts: [], revision }
  }

  async function undoSheetRevision(revisionId: string): Promise<RevisionResult> {
    await init()
    const revision = revisions.value.find((item) => item.id === revisionId)
    if (!revision) {
      return { ok: false, conflicts: ['未找到该修订记录。'] }
    }
    if (revision.status !== '已生效') {
      return { ok: false, conflicts: ['该修订已撤销，不能重复撤销。'] }
    }

    const source = sheets.value.find((sheet) => sheet.id === revision.sheetId)
    if (!source) {
      return { ok: false, conflicts: ['图幅卡已被移除，无法撤销该修订。'] }
    }

    const conflicts: string[] = []
    if (source.code !== revision.newCode) {
      conflicts.push(
        `图幅现行号已不是修订后的新号「${revision.newCode}」，关联关系可能已变化，无法撤销。`,
      )
    }
    const occupant = sheets.value.find(
      (sheet) => sheet.id !== source.id && sheet.code === revision.oldCode,
    )
    if (occupant) {
      conflicts.push(
        `旧号「${revision.oldCode}」已被图幅《${occupant.title}》占用，撤销后无法恢复旧号。`,
      )
    }
    const currentAffected = sheets.value.filter(
      (sheet) => sheet.id !== source.id && sheet.neighborCodes.includes(revision.newCode),
    )
    const currentIds = currentAffected.map((sheet) => sheet.id).sort()
    const expectedIds = [...revision.affectedSheetIds].sort()
    if (
      currentIds.length !== expectedIds.length ||
      currentIds.some((id, index) => id !== expectedIds[index])
    ) {
      conflicts.push('邻接关系已发生变化，撤销会遗留或误改其他图幅的引用，请先手工核对邻接登记。')
    }

    if (conflicts.length > 0) {
      return { ok: false, conflicts }
    }

    const undoneAt = new Date().toISOString()
    await db.transaction('rw', db.sheets, db.sheetRevisions, async () => {
      await db.sheets.update(source.id, { code: revision.oldCode })
      for (const sheet of currentAffected) {
        await db.sheets.update(sheet.id, {
          neighborCodes: replaceNeighborCode(sheet.neighborCodes, revision.newCode, revision.oldCode),
        })
      }
      await db.sheetRevisions.update(revision.id, { status: '已撤销', undoneAt })
    })

    source.code = revision.oldCode
    for (const sheet of currentAffected) {
      sheet.neighborCodes = replaceNeighborCode(sheet.neighborCodes, revision.newCode, revision.oldCode)
    }
    revision.status = '已撤销'
    revision.undoneAt = undoneAt

    return { ok: true, conflicts: [], revision }
  }

  return {
    sheets,
    allScans,
    revisions,
    currentSheet,
    currentScans,
    loading,
    initialized,
    init,
    addSheet,
    loadSheet,
    addScan,
    setPrimaryScan,
    getSheetById,
    getSheetByCode,
    getScansForSheet,
    getRevisionsForSheet,
    getLatestEffectiveRevision,
    reviseSheetCode,
    undoSheetRevision,
  }
})
