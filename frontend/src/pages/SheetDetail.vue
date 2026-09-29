<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useSheetStore, type NewScanItem } from '../stores/sheetStore'
import { usePlaceStore } from '../stores/placeStore'
import type { ColorMode, ScanQuality } from '../types/scan'
import { COLOR_MODES, SCAN_QUALITIES } from '../types/scan'
import type { SheetRevision } from '../types/revision'
import { usePlaceSearch } from '../hooks/usePlaceSearch'
import { estimateSheetSpan, scaleToText } from '../utils/scale'
import { downloadJson } from '../utils/export'
import PairRow from '../components/common/PairRow.vue'
import ScanCard from '../components/common/ScanCard.vue'
import VacantHint from '../components/common/VacantHint.vue'

const route = useRoute()
const sheetStore = useSheetStore()
const placeStore = usePlaceStore()
const searchKeyword = ref('')
const { hits } = usePlaceSearch(searchKeyword)
const showScanForm = ref(false)

const reviseForm = reactive({ newCode: '', reason: '' })
const revisionConflicts = ref<string[]>([])
const revisionNotice = ref<{ type: 'success' | 'error'; text: string } | null>(null)
const undoingId = ref('')

const sheetId = computed(() => String(route.params.id ?? ''))
const sheet = computed(() => {
  const current = sheetStore.currentSheet
  return current?.id === sheetId.value ? current : undefined
})
const relatedPlaces = computed(() => placeStore.getPairsForSheet(sheetId.value))
const relatedHits = computed(() => hits.value.filter((hit) => hit.pair.sheetId === sheetId.value))
const spanEstimate = computed(() => (sheet.value ? estimateSheetSpan(sheet.value.scale, sheet.value.sheetSizeCm) : undefined))

function createScanForm(): NewScanItem {
  return {
    sheetId: sheetId.value,
    fileName: '',
    resolutionDpi: 600,
    colorMode: '彩色',
    pieces: 1,
    quality: '清晰',
    storageNote: '',
    importedAt: new Date().toISOString(),
    isPrimary: false,
  }
}

const scanForm = reactive<NewScanItem>(createScanForm())
const scanFormError = ref('')

function resetScanForm(): void {
  Object.assign(scanForm, createScanForm())
  scanFormError.value = ''
}

async function submitScan(): Promise<void> {
  if (!scanForm.fileName.trim() || !scanForm.storageNote.trim()) {
    scanFormError.value = '请填写扫描文件名与存放位置。'
    return
  }
  await sheetStore.addScan({
    ...scanForm,
    sheetId: sheetId.value,
    fileName: scanForm.fileName.trim(),
    storageNote: scanForm.storageNote.trim(),
  })
  resetScanForm()
  showScanForm.value = false
}

function exportSheet(): void {
  if (!sheet.value) {
    return
  }
  downloadJson(`${sheet.value.code}-编目.json`, {
    sheet: sheet.value,
    scans: sheetStore.getScansForSheet(sheet.value.id),
    placePairs: relatedPlaces.value,
  })
}

/** 实时预览：换号后需要同步更新邻接号的图幅（把本图幅列为邻接的图幅）。 */
const affectedPreview = computed(() => {
  if (!sheet.value) {
    return []
  }
  const currentCode = sheet.value.code
  return sheetStore.sheets.filter(
    (item) => item.id !== sheetId.value && item.neighborCodes.includes(currentCode),
  )
})

/** 实时预览：新号占用等冲突，仅作提前提示；提交时会再做一次完整核对。 */
const previewConflicts = computed(() => {
  const conflicts: string[] = []
  const newCode = reviseForm.newCode.trim()
  if (!newCode || !sheet.value) {
    return conflicts
  }
  if (newCode === sheet.value.code) {
    conflicts.push('新号与现行图号相同，无需修订。')
  }
  if (sheet.value.neighborCodes.includes(newCode)) {
    conflicts.push(`新号「${newCode}」与本图幅登记的邻接图号相同，换号后会形成自邻接。`)
  }
  const occupied = sheetStore.sheets.find(
    (item) => item.id !== sheetId.value && item.code === newCode,
  )
  if (occupied) {
    conflicts.push(`新号「${newCode}」已被占用：《${occupied.title}》（${occupied.code}）。`)
  }
  return conflicts
})

const sheetRevisions = computed<SheetRevision[]>(() => sheetStore.getRevisionsForSheet(sheetId.value))
const latestEffectiveRevision = computed<SheetRevision | undefined>(() =>
  sheetStore.getLatestEffectiveRevision(sheetId.value),
)
const affectedCompiledCount = computed(
  () => affectedPreview.value.filter((item) => item.status === '已编').length,
)

function resetReviseForm(): void {
  reviseForm.newCode = ''
  reviseForm.reason = ''
  revisionConflicts.value = []
  revisionNotice.value = null
}

async function submitRevision(): Promise<void> {
  if (!sheet.value) {
    return
  }
  revisionConflicts.value = []
  revisionNotice.value = null
  const result = await sheetStore.reviseSheetCode({
    sheetId: sheetId.value,
    newCode: reviseForm.newCode,
    reason: reviseForm.reason,
    expectedOldCode: sheet.value.code,
    expectedAffectedIds: affectedPreview.value.map((item) => item.id),
  })
  if (result.ok && result.revision) {
    revisionNotice.value = {
      type: 'success',
      text: `已生效：${result.revision.oldCode} → ${result.revision.newCode}，${result.revision.affectedSheetIds.length} 幅邻接图幅已同步换号。`,
    }
    reviseForm.newCode = ''
    reviseForm.reason = ''
  } else {
    revisionConflicts.value = result.conflicts
    revisionNotice.value = { type: 'error', text: '本次修订未写入，请核对以下原因后重试。' }
  }
}

async function undoRevision(revision: SheetRevision): Promise<void> {
  undoingId.value = revision.id
  revisionConflicts.value = []
  revisionNotice.value = null
  try {
    const result = await sheetStore.undoSheetRevision(revision.id)
    if (result.ok) {
      revisionNotice.value = {
        type: 'success',
        text: `已撤销修订：${revision.newCode} 恢复为 ${revision.oldCode}，邻接图幅已同步回退。`,
      }
    } else {
      revisionConflicts.value = result.conflicts
      revisionNotice.value = { type: 'error', text: '撤销未生效，已保留现状。' }
    }
  } finally {
    undoingId.value = ''
  }
}

async function initialize(): Promise<void> {
  await Promise.all([sheetStore.init(), placeStore.init()])
  await sheetStore.loadSheet(sheetId.value)
}

onMounted(() => {
  void initialize()
})

watch(sheetId, () => {
  resetScanForm()
  resetReviseForm()
  void sheetStore.loadSheet(sheetId.value)
})
</script>

<template>
  <section v-if="sheet" class="page" data-testid="detail-sheet">
    <div class="detail-layout">
      <div>
        <header class="detail-hero">
          <span class="detail-hero__code">{{ sheet.code }} · {{ sheet.series }}</span>
          <h1>{{ sheet.title }}</h1>
          <p>{{ sheet.projection }}，图幅尺寸 {{ sheet.sheetSizeCm }}。现登记 {{ relatedPlaces.length }} 条地名对照。</p>
          <div class="detail-hero__tags">
            <el-tag type="warning" effect="dark">{{ sheet.year }} 年</el-tag>
            <el-tag type="info" effect="dark">{{ sheet.scale }}</el-tag>
            <el-tag effect="dark">{{ sheet.status }}</el-tag>
            <el-tag v-if="spanEstimate" effect="dark">
              约 {{ spanEstimate.widthKm }} × {{ spanEstimate.heightKm }} 公里
            </el-tag>
          </div>
        </header>

        <div class="section-title">
          <div>
            <h2>扫描件条目</h2>
            <span class="muted">主用件优先作为地名核录与拼合基准</span>
          </div>
          <el-button type="primary" plain @click="showScanForm = true">登记扫描件</el-button>
        </div>

        <form v-if="showScanForm" class="inline-form" @submit.prevent="submitScan">
          <h2>登记扫描件</h2>
          <div class="form-grid">
            <el-form-item label="扫描文件名" required>
              <input v-model="scanForm.fileName" class="native-field" />
            </el-form-item>
            <el-form-item label="分辨率">
              <input v-model.number="scanForm.resolutionDpi" class="native-field" type="number" min="72" max="1200" />
            </el-form-item>
            <el-form-item label="色彩模式">
              <select v-model="scanForm.colorMode" class="native-field">
                <option v-for="mode in COLOR_MODES" :key="mode" :value="mode">{{ mode }}</option>
              </select>
            </el-form-item>
            <el-form-item label="分块数">
              <input v-model.number="scanForm.pieces" class="native-field" type="number" min="1" />
            </el-form-item>
            <el-form-item label="图像质量">
              <select v-model="scanForm.quality" class="native-field">
                <option v-for="quality in SCAN_QUALITIES" :key="quality" :value="quality">{{ quality }}</option>
              </select>
            </el-form-item>
            <el-form-item label="存放位置" required>
              <input v-model="scanForm.storageNote" class="native-field" />
            </el-form-item>
            <el-form-item label="设为主用件">
              <el-switch v-model="scanForm.isPrimary" />
            </el-form-item>
            <div class="form-actions">
              <el-button @click="showScanForm = false; resetScanForm()">取消</el-button>
              <el-button type="primary" native-type="submit">保存扫描件</el-button>
            </div>
          </div>
          <p v-if="scanFormError" class="text-danger">{{ scanFormError }}</p>
        </form>

        <div class="scan-list">
          <ScanCard v-for="scan in sheetStore.currentScans" :key="scan.id" :scan="scan" />
          <div v-if="sheetStore.currentScans.length === 0" class="empty-inline">该图幅尚未登记扫描件。</div>
        </div>
        <div v-if="sheetStore.currentScans.length" class="section-title">
          <span class="muted">主用件标记可随时切换，原主用件会自动取消。</span>
          <div>
            <el-button
              v-for="scan in sheetStore.currentScans"
              :key="`primary-${scan.id}`"
              link
              :type="scan.isPrimary ? 'success' : 'primary'"
              :disabled="scan.isPrimary"
              @click="sheetStore.setPrimaryScan(scan.id)"
            >
              {{ scan.isPrimary ? '当前主用件' : `设为主用件：${scan.fileName}` }}
            </el-button>
          </div>
        </div>
      </div>

      <aside>
        <section class="side-panel">
          <h2>编目摘要</h2>
          <dl class="fact-list">
            <div><dt>图幅号</dt><dd>{{ sheet.code }}</dd></div>
            <div><dt>所属图组</dt><dd>{{ sheet.series }}</dd></div>
            <div><dt>年代</dt><dd>{{ sheet.year }} 年</dd></div>
            <div><dt>比例尺</dt><dd>{{ sheet.scale }}</dd></div>
            <div><dt>比例尺说明</dt><dd>{{ scaleToText(sheet.scale) }}</dd></div>
            <div><dt>投影</dt><dd>{{ sheet.projection }}</dd></div>
            <div><dt>尺寸</dt><dd>{{ sheet.sheetSizeCm }}</dd></div>
            <div v-if="spanEstimate"><dt>估算跨度</dt><dd>{{ spanEstimate.longitudeSpan }} × {{ spanEstimate.latitudeSpan }}</dd></div>
            <div><dt>扫描件</dt><dd>{{ sheetStore.currentScans.length }} 件</dd></div>
            <div><dt>地名对照</dt><dd>{{ relatedPlaces.length }} 条</dd></div>
          </dl>
          <div class="mt-20">
            <router-link :to="`/sheets/${sheet.id}/neighbors`"><el-button>查看邻接与拼合预览</el-button></router-link>
            <el-button type="primary" plain @click="exportSheet">导出 JSON</el-button>
          </div>
        </section>

        <section class="side-panel revision-panel">
          <h2>编号修订</h2>
          <p class="muted">
            填写新号与原因后，所有把本图幅列为邻接的图幅会一起换号；修订历史保存旧号、新号、原因与受影响图幅，可随时撤销最近一次已生效修订。
          </p>

          <form class="revision-form" @submit.prevent="submitRevision">
            <el-form-item label="新图幅号" required>
              <input v-model="reviseForm.newCode" class="native-field" placeholder="例如：北平-甲-3-甲" data-testid="field-new-code" />
            </el-form-item>
            <el-form-item label="换号原因" required>
              <textarea
                v-model="reviseForm.reason"
                class="native-field"
                placeholder="例如：按新编号体系调整，原号与天津图幅重号"
                data-testid="field-revision-reason"
              ></textarea>
            </el-form-item>

            <div v-if="affectedPreview.length" class="revision-preview">
              <p class="revision-preview__title">
                受影响图幅（{{ affectedPreview.length }} 幅，邻接号将同步换号）：
              </p>
              <ul class="revision-preview__list">
                <li v-for="item in affectedPreview" :key="item.id">
                  <span class="revision-preview__code">{{ item.code }}</span>
                  <span class="muted"> · {{ item.title }}</span>
                  <el-tag size="small" :type="item.status === '已编' ? 'success' : 'info'" effect="plain">
                    {{ item.status }}
                  </el-tag>
                </li>
              </ul>
              <p v-if="affectedCompiledCount" class="muted">
                其中 {{ affectedCompiledCount }} 幅为已编图幅，换号后请在下方修订历史中核对，记录可撤销。
              </p>
            </div>
            <div v-else class="revision-preview revision-preview--empty">
              <p class="muted">暂无其他图幅把本图幅列为邻接，换号不会影响邻接登记。</p>
            </div>

            <ul v-if="previewConflicts.length" class="revision-conflicts" data-testid="revision-conflicts">
              <li v-for="(conflict, index) in previewConflicts" :key="index">{{ conflict }}</li>
            </ul>

            <div class="form-actions">
              <el-button
                type="primary"
                native-type="submit"
                data-testid="submit-revision"
                :disabled="previewConflicts.length > 0 || !reviseForm.newCode.trim() || !reviseForm.reason.trim()"
              >
                确认换号
              </el-button>
            </div>
          </form>

          <p v-if="revisionNotice" class="revision-notice" :class="`revision-notice--${revisionNotice.type}`">
            {{ revisionNotice.text }}
          </p>
          <ul v-if="revisionConflicts.length" class="revision-conflicts" data-testid="revision-conflicts-submit">
            <li v-for="(conflict, index) in revisionConflicts" :key="index">{{ conflict }}</li>
          </ul>

          <div class="revision-history">
            <h3>修订历史</h3>
            <div v-if="sheetRevisions.length" class="revision-list">
              <article v-for="revision in sheetRevisions" :key="revision.id" class="revision-item">
                <div class="revision-item__head">
                  <span class="revision-item__codes">
                    <del>{{ revision.oldCode }}</del>
                    →
                    <strong>{{ revision.newCode }}</strong>
                  </span>
                  <el-tag size="small" :type="revision.status === '已生效' ? 'success' : 'info'" effect="dark">
                    {{ revision.status }}
                  </el-tag>
                </div>
                <p class="revision-item__reason">{{ revision.reason }}</p>
                <p class="muted">
                  {{ revision.createdAt }} · 受影响 {{ revision.affectedSheetIds.length }} 幅
                  <span v-if="revision.affectedSheetCodes.length">
                    （{{ revision.affectedSheetCodes.join('、') }}）
                  </span>
                </p>
                <p v-if="revision.undoneAt" class="muted">已于 {{ revision.undoneAt }} 撤销。</p>
                <el-button
                  v-if="revision.status === '已生效' && latestEffectiveRevision?.id === revision.id"
                  size="small"
                  type="warning"
                  plain
                  :loading="undoingId === revision.id"
                  :data-testid="`undo-revision-${revision.id}`"
                  @click="undoRevision(revision)"
                >
                  撤销本次修订
                </el-button>
              </article>
            </div>
            <p v-else class="muted">暂无修订记录。</p>
          </div>
        </section>
      </aside>
    </div>

    <section class="section-title">
      <div>
        <h2>图内地名核录</h2>
        <span class="muted">可检索本图幅的古名、今名、异写与图上方位。</span>
      </div>
      <el-input v-model="searchKeyword" clearable placeholder="检索本地名" style="width: 260px" />
    </section>

    <div v-if="relatedPlaces.length" class="place-list">
      <PairRow
        v-for="pair in relatedHits.length || !searchKeyword ? relatedPlaces : []"
        :key="pair.id"
        :pair="pair"
        :query="searchKeyword"
        :sheet-code="sheet.code"
      />
      <div v-if="searchKeyword && relatedHits.length === 0" class="empty-inline">本地名未检索到吻合记录。</div>
    </div>
  </section>

  <section v-else class="page">
    <h1>图幅详情</h1>
    <VacantHint title="未找到该图幅" description="图幅可能已被移除，请返回编目台重新选择。" />
  </section>
</template>
