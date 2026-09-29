<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useCodeRevisionStore } from '../stores/codeRevisionStore'
import { useSheetStore } from '../stores/sheetStore'
import { NEIGHBOR_DIRECTIONS } from '../hooks/useSheetNeighbors'
import type { CodeRevision, RevisionPrecheck } from '../types/codeRevision'
import type { Sheet } from '../types/sheet'

const props = defineProps<{ sheet: Sheet }>()

const revisionStore = useCodeRevisionStore()
const sheetStore = useSheetStore()
const { revisions } = storeToRefs(revisionStore)

const dialogVisible = ref(false)
const submitting = ref(false)
const form = reactive({ newCode: '', reason: '' })
const livePrecheck = ref<RevisionPrecheck | null>(null)
const submitBlocks = ref<string[]>([])
const undoError = ref('')

const sheetRevisions = computed(() => revisionStore.revisionsForSheet(props.sheet.id))
const pendingItems = computed(() => revisionStore.pendingItemsForSheet(props.sheet.id))
const latestGlobal = computed(() => revisionStore.latestActiveRevision())

const affectedRows = computed(() =>
  (livePrecheck.value?.affectedSheets ?? []).map((item) => {
    const target = sheetStore.getSheetById(item.sheetId)
    return {
      ...item,
      code: target?.code ?? item.codeBefore,
      title: target?.title ?? '（缺编图号）',
      direction:
        typeof item.directionIndex === 'number'
          ? NEIGHBOR_DIRECTIONS[item.directionIndex] ?? '—'
          : '本图幅',
    }
  }),
)

async function refreshPrecheck(): Promise<void> {
  submitBlocks.value = []
  if (!form.newCode.trim()) {
    livePrecheck.value = null
    return
  }
  livePrecheck.value = await revisionStore.precheckRevision({
    sheetId: props.sheet.id,
    newCode: form.newCode,
  })
}

watch(
  () => [dialogVisible.value, form.newCode] as const,
  () => {
    if (dialogVisible.value) {
      void refreshPrecheck()
    }
  },
)

function openDialog(): void {
  form.newCode = ''
  form.reason = ''
  livePrecheck.value = null
  submitBlocks.value = []
  dialogVisible.value = true
}

async function submitRevision(): Promise<void> {
  submitBlocks.value = []
  submitting.value = true
  try {
    const result = await revisionStore.applyRevision({
      sheetId: props.sheet.id,
      newCode: form.newCode,
      reason: form.reason,
    })
    if (result.ok) {
      dialogVisible.value = false
    } else {
      submitBlocks.value = (result.precheck?.blocks ?? []).map((block) => block.message)
      if (result.precheck) {
        livePrecheck.value = result.precheck
      }
    }
  } finally {
    submitting.value = false
  }
}

async function confirmUndo(revision: CodeRevision): Promise<void> {
  undoError.value = ''
  const outcome = await revisionStore.undoRevision(revision.id)
  if (!outcome.ok) {
    undoError.value = outcome.blocks.map((block) => block.message).join('；')
  }
}

async function markResolved(revisionId: string, itemId: string): Promise<void> {
  await revisionStore.resolvePendingItem(revisionId, itemId)
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false })
}

function affectedSummary(revision: CodeRevision): string {
  const referrers = revision.affectedSheets.filter((item) => item.sheetId !== revision.sheetId)
  const catalogued = revision.affectedSheets.filter((item) => item.catalogued).length
  return `涉及图幅 ${revision.affectedSheets.length} 张（邻接引用同步改写 ${referrers.length} 张，已编 ${catalogued} 张）`
}
</script>

<template>
  <section class="revision-panel">
    <div class="section-title">
      <div>
        <h2>编号修订</h2>
        <span class="muted">换号后，其他把旧号列为邻接的图幅将一并改写；已编图幅留下待处理记录。</span>
      </div>
      <el-button type="primary" plain data-testid="open-revision" @click="openDialog">修订图幅编号</el-button>
    </div>

    <el-alert
      v-for="item in pendingItems"
      :key="item.id"
      class="revision-alert"
      type="warning"
      :closable="false"
      show-icon
    >
      <template #title>
        <div class="pending-row">
          <span>
            <el-tag size="small" :type="item.kind === 'target' ? 'danger' : 'warning'">
              {{ item.kind === 'target' ? '本图幅待处理' : '邻接引用待处理' }}
            </el-tag>
            {{ item.description }}
          </span>
          <el-button size="small" type="warning" plain @click="markResolved(item.revisionId, item.id)">
            标记已处理
          </el-button>
        </div>
      </template>
    </el-alert>

    <p v-if="undoError" class="text-danger revision-error">{{ undoError }}</p>

    <div v-if="sheetRevisions.length" class="revision-list">
      <article v-for="revision in sheetRevisions" :key="revision.id" class="revision-item">
        <header class="revision-item__head">
          <div class="revision-item__codes">
            <span class="revision-code revision-code--old">{{ revision.oldCode }}</span>
            <span class="revision-arrow">→</span>
            <span class="revision-code revision-code--new">{{ revision.newCode }}</span>
          </div>
          <el-tag :type="revision.status === 'active' ? 'success' : 'info'" effect="plain" size="small">
            {{ revision.status === 'active' ? '已生效' : '已撤销' }}
          </el-tag>
        </header>
        <p class="revision-item__reason">原因：{{ revision.reason }}</p>
        <p class="revision-item__meta muted">
          {{ formatTime(revision.appliedAt) }} · {{ affectedSummary(revision) }}
          <template v-if="revision.status === 'undone' && revision.undoneAt">
            · 撤销于 {{ formatTime(revision.undoneAt) }}
          </template>
        </p>
        <ul class="revision-affected">
          <li v-for="affected in revision.affectedSheets" :key="affected.sheetId">
            <el-tag size="small" :type="affected.sheetId === revision.sheetId ? 'danger' : 'info'" effect="plain">
              {{ affected.sheetId === revision.sheetId ? '被修订' : '邻接引用' }}
            </el-tag>
            {{ affected.codeBefore }}
            <template v-if="affected.codeBefore !== affected.codeAfter"> → {{ affected.codeAfter }}</template>
            <el-tag v-if="affected.catalogued" size="small" type="warning" effect="plain">已编</el-tag>
            <el-tag v-else size="small" type="info" effect="plain">非已编</el-tag>
          </li>
        </ul>
        <el-popconfirm
          v-if="revision.status === 'active' && latestGlobal?.id === revision.id"
          title="撤销后旧号与邻接引用将还原；若旧号被占用或关系已改动则不会写入。确认撤销最近一次修订？"
          confirm-button-text="确认撤销"
          cancel-button-text="再想想"
          @confirm="confirmUndo(revision)"
        >
          <template #reference>
            <el-button size="small" type="danger" plain data-testid="undo-revision">撤销本次修订</el-button>
          </template>
        </el-popconfirm>
        <p v-else-if="revision.status === 'active'" class="muted revision-item__hint">
          此后已有更新的修订生效，需按时间倒序先撤销更近的一次。
        </p>
      </article>
    </div>
    <div v-else class="empty-inline">本图幅尚无编号修订记录。</div>

    <el-dialog v-model="dialogVisible" title="修订图幅编号" width="640px" :close-on-click-modal="false">
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="当前图幅号">
          <el-input :model-value="sheet.code" disabled />
        </el-form-item>
        <el-form-item label="新图幅号" required>
          <el-input
            v-model="form.newCode"
            data-testid="revision-new-code"
            placeholder="填写新的图幅编号"
            clearable
          />
        </el-form-item>
        <el-form-item label="修订原因" required>
          <el-input
            v-model="form.reason"
            type="textarea"
            :rows="3"
            data-testid="revision-reason"
            placeholder="例如：原编号与邻幅重号，按 1935 年馆藏目录改号"
          />
        </el-form-item>

        <el-alert
          v-for="block in livePrecheck?.blocks ?? []"
          :key="block.code"
          class="revision-alert"
          type="error"
          :title="block.message"
          :closable="false"
          show-icon
        />
        <el-alert
          v-for="notice in livePrecheck?.notices ?? []"
          :key="notice.code"
          class="revision-alert"
          type="warning"
          :title="notice.message"
          :closable="false"
          show-icon
        />

        <div v-if="livePrecheck && !livePrecheck.blocked" class="revision-preview">
          <p class="revision-preview__title">本次将影响以下图幅：</p>
          <ul>
            <li v-for="row in affectedRows" :key="row.sheetId">
              <strong>{{ row.code }}</strong>
              <span class="muted">《{{ row.title }}》</span>
              <el-tag size="small" :type="row.sheetId === sheet.id ? 'danger' : 'info'" effect="plain">
                {{ row.sheetId === sheet.id ? '换号主体' : `${row.direction}向邻接引用` }}
              </el-tag>
              <el-tag size="small" :type="row.catalogued ? 'warning' : 'success'" effect="plain">
                {{ row.catalogued ? '已编·将留待处理记录' : '非已编' }}
              </el-tag>
            </li>
          </ul>
        </div>

        <el-alert
          v-for="(message, index) in submitBlocks"
          :key="`submit-${index}`"
          class="revision-alert"
          type="error"
          :title="message"
          :closable="false"
          show-icon
        />
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="!form.newCode.trim() || !form.reason.trim() || !!livePrecheck?.blocked"
          data-testid="submit-revision"
          @click="submitRevision"
        >
          生效修订
        </el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.revision-panel {
  margin-top: 8px;
}

.revision-alert {
  margin-top: 10px;
}

.revision-error {
  margin-top: 10px;
}

.revision-list {
  display: grid;
  gap: 12px;
  margin-top: 14px;
}

.revision-item {
  padding: 16px 18px;
  background: #faf5ec;
  border: 1px solid #d4c3ae;
  border-radius: 8px;
}

.revision-item__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.revision-item__codes {
  display: flex;
  align-items: center;
  gap: 10px;
}

.revision-code {
  font-family: Georgia, "Songti SC", serif;
  font-size: 17px;
  font-weight: 700;
}

.revision-code--old {
  color: #a33f32;
  text-decoration: line-through;
}

.revision-code--new {
  color: var(--moss);
}

.revision-arrow {
  color: #aa8c72;
}

.revision-item__reason {
  margin: 10px 0 4px;
  line-height: 1.7;
}

.revision-item__meta {
  margin: 0 0 8px;
  font-size: 12px;
}

.revision-item__hint {
  margin: 8px 0 0;
  font-size: 12px;
}

.revision-affected {
  display: grid;
  gap: 6px;
  margin: 0 0 12px;
  padding: 10px 12px;
  background: #f1e8d9;
  border-radius: 6px;
  list-style: none;
  font-size: 13px;
}

.revision-affected li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.revision-preview {
  margin-top: 12px;
  padding: 12px 14px;
  background: #f1e8d9;
  border: 1px solid #d7c6b3;
  border-radius: 6px;
}

.revision-preview__title {
  margin-bottom: 8px;
  font-weight: 700;
}

.revision-preview ul {
  display: grid;
  gap: 8px;
  margin: 0;
  padding-left: 0;
  list-style: none;
}

.revision-preview li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.pending-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
</style>
