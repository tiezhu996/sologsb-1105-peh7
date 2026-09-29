/**
 * 图幅编号修订：换号时同步改写所有把旧号列为邻接的图幅，
 * 并为已编图幅留下待处理记录；修订历史可追溯、最近一次可撤销。
 */

export type CodeRevisionStatus = 'active' | 'undone'

/** 修订后需要整理员人工复核的待处理事项 */
export interface PendingItem {
  id: string
  /** target：被修订图幅自身；reference：邻接关系中引用旧号的图幅 */
  kind: 'target' | 'reference'
  sheetId: string
  /** 记录生成时该图幅使用的图号 */
  sheetCode: string
  description: string
  resolved: boolean
  resolvedAt?: string
}

/** 受本次修订影响的图幅摘要，作为历史留痕 */
export interface AffectedSheet {
  sheetId: string
  /** 修订前使用的图号 */
  codeBefore: string
  /** 修订后使用的图号（被修订图幅为新号，引用方图号不变） */
  codeAfter: string
  /** 该图幅在邻接关系中引用旧号的方向位次（仅引用方） */
  directionIndex?: number
  /** 该图幅在修订生效时是否已编，决定是否生成待处理记录 */
  catalogued: boolean
}

/**
 * 修订生效瞬间的关联关系快照。
 * 后续撤销或再次修订时据此判断“关联关系是否发生变化”，
 * 一旦关系已被人工改动，操作不再写入以免覆盖新的整理成果。
 */
export interface RelationSnapshot {
  targetId: string
  /** 被修订图幅修订前的邻接图号（被修订图幅通常不引用自身） */
  targetNeighborCodes: string[]
  /** 引用方图幅 id -> 修订前邻接图号 */
  referrers: Record<string, string[]>
}

export interface CodeRevision {
  id: string
  status: CodeRevisionStatus
  sheetId: string
  oldCode: string
  newCode: string
  reason: string
  affectedSheets: AffectedSheet[]
  pendingItems: PendingItem[]
  relationSnapshot: RelationSnapshot
  appliedAt: string
  undoneAt?: string
}

/** 预检中阻止写入的冲突 */
export interface RevisionBlock {
  code:
    | 'new-code-required'
    | 'new-code-same'
    | 'target-missing'
    | 'new-code-occupied'
    | 'relation-changed'
    | 'not-latest'
    | 'old-code-occupied'
  message: string
}

/** 不阻止写入、但需要整理员知晓的提示 */
export interface RevisionNotice {
  code: 'target-catalogued' | 'referrer-catalogued' | 'vacant-code-taken' | 'self-reference'
  message: string
}

export interface RevisionPrecheck {
  blocked: boolean
  blocks: RevisionBlock[]
  notices: RevisionNotice[]
  affectedSheets: AffectedSheet[]
  pendingItems: PendingItem[]
  /** 申请修订时的关联关系快照 */
  snapshot: RelationSnapshot
  /** 当前把旧号列为邻接的图幅 id */
  referrerIds: string[]
  /** 当前邻接表中预留了新号（缺编）的图幅 id */
  vacantNewCodeReferrerIds: string[]
}
