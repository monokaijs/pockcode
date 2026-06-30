import { ArrowDownToLine, ArrowUpFromLine, ListFilter, RefreshCw, Search } from "lucide-react"
import { CloudflaredPanelSummary, useCloudflaredPanelState } from "@/components/session/cloudflared-panel"
import { FileTreeView } from "@/components/session/file-tree-view"
import { GitPanelSummary, useGitPanelState } from "@/components/session/git-panel-summary"
import { PanelActionButton } from "@/components/session/panel-action-button"
import { cn } from "@/lib/utils"
import type { PanelTab, Workspace } from "@/types/session"

export function RightPanel({
  activeTab,
  expandedFolderIds,
  loadingFolderIds,
  selectedFileId,
  treeId,
  workspace,
  onFileSelect,
  onFolderToggle,
  onTabChange,
}: {
  activeTab: PanelTab
  expandedFolderIds: Set<string>
  loadingFolderIds: Set<string>
  selectedFileId: string
  treeId: string
  workspace: Workspace
  onFileSelect: (id: string) => void
  onFolderToggle: (id: string) => void
  onTabChange: (tab: PanelTab) => void
}) {
  const gitPanel = useGitPanelState(workspace.path)
  const cloudflaredPanel = useCloudflaredPanelState(activeTab === "tunnels")

  return (
    <aside className="grid h-full min-h-0 min-w-0 max-w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex h-10 min-w-0 items-center gap-3 px-3">
        <div className="flex min-w-0 gap-1 text-[12px] font-semibold">
          <button
            className={cn("rounded-md px-1.5 py-0.5", activeTab === "files" ? "bg-accent text-foreground" : "text-muted-foreground")}
            type="button"
            onClick={() => onTabChange("files")}
          >
            Files
          </button>
          <button
            className={cn("rounded-md px-1.5 py-0.5", activeTab === "git" ? "bg-accent text-foreground" : "text-muted-foreground")}
            type="button"
            onClick={() => onTabChange("git")}
          >
            Git
          </button>
          <button
            className={cn("rounded-md px-1.5 py-0.5", activeTab === "tunnels" ? "bg-accent text-foreground" : "text-muted-foreground")}
            type="button"
            onClick={() => onTabChange("tunnels")}
          >
            Tunnels
          </button>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1 text-muted-foreground">
          {activeTab === "files" ? (
            <>
              <PanelActionButton label="Refresh files">
                <RefreshCw className="size-4" />
              </PanelActionButton>
              <PanelActionButton label="Search files">
                <Search className="size-4" />
              </PanelActionButton>
              <PanelActionButton label="Filter files">
                <ListFilter className="size-4" />
              </PanelActionButton>
            </>
          ) : activeTab === "git" ? (
            <>
              <PanelActionButton
                disabled={!gitPanel.canUseRepository || gitPanel.isBusy}
                label="Pull"
                onClick={() => void gitPanel.pull()}
              >
                <ArrowDownToLine className="size-4" />
              </PanelActionButton>
              <PanelActionButton
                disabled={!gitPanel.canUseRepository || gitPanel.isBusy}
                label="Push"
                onClick={() => void gitPanel.push()}
              >
                <ArrowUpFromLine className="size-4" />
              </PanelActionButton>
              <PanelActionButton
                disabled={gitPanel.isBusy}
                label="Refresh source control"
                onClick={() => void gitPanel.refresh()}
              >
                <RefreshCw className={cn("size-4", gitPanel.isLoading && "animate-spin")} />
              </PanelActionButton>
            </>
          ) : activeTab === "tunnels" ? (
            <PanelActionButton
              disabled={cloudflaredPanel.isBusy}
              label="Refresh tunnels"
              onClick={() => void cloudflaredPanel.refresh()}
            >
              <RefreshCw className={cn("size-4", cloudflaredPanel.isLoading && "animate-spin")} />
            </PanelActionButton>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 min-w-0 max-w-full overflow-auto px-1.5 pb-3 pt-1 ide-scrollbar">
        {activeTab === "files" ? (
          <FileTreeView
            expandedFolderIds={expandedFolderIds}
            loadingFolderIds={loadingFolderIds}
            nodes={workspace.fileTree}
            selectedFileId={selectedFileId}
            treeId={treeId}
            onFileSelect={onFileSelect}
            onFolderToggle={onFolderToggle}
          />
        ) : activeTab === "git" ? (
          <GitPanelSummary gitPanel={gitPanel} workspace={workspace} />
        ) : (
          <CloudflaredPanelSummary cloudflaredPanel={cloudflaredPanel} />
        )}
      </div>
    </aside>
  )
}
