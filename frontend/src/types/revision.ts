export type RevisionStatus = '已生效' | '已撤销'

export interface SheetRevision {
  id: string
  sheetId: string
  oldCode: string
  newCode: string
  reason: string
  status: RevisionStatus
  /** 换号时把本图幅列为邻接的图幅 ID */
  affectedSheetIds: string[]
  /** 受影响图幅在修订时的图号快照，用于历史展示 */
  affectedSheetCodes: string[]
  createdAt: string
  undoneAt?: string
}

export const REVISION_STATUSES: RevisionStatus[] = ['已生效', '已撤销']
