import type ObsidianGit from "../main";

export type MobileGitOp =
    | "clone"
    | "fetch"
    | "pull"
    | "push"
    | "commit"
    | "checkout"
    | "merge";

/**
 * Owns iOS/Android-specific lifecycle handling for the isomorphic-git path:
 *
 *  - Tracks the {@link AbortController} for the current git op so the
 *    plugin can cancel between requests when the WebView is hidden.
 *  - On `visibilitychange` (hidden) and `pagehide`, flushes the cached
 *    `.git/index` to disk and aborts any in-flight op so iOS does not
 *    suspend the WebView with a half-written repository.
 *  - On `visibilitychange` (visible), notifies the automatics scheduler
 *    so missed auto-pull / auto-commit ticks fire promptly.
 *
 * Only registered when the isomorphic-git backend is selected (i.e. on
 * mobile). The simple-git desktop backend never instantiates this class.
 */
export class MobileLifecycleManager {
    private currentOp: MobileGitOp | undefined;
    private currentController: AbortController | undefined;
    private visibilityListener?: () => void;
    private pageHideListener?: () => void;
    private freezeListener?: () => void;

    constructor(private readonly plugin: ObsidianGit) {}

    register(): void {
        if (this.visibilityListener) return;

        this.visibilityListener = () => {
            if (document.visibilityState === "hidden") {
                void this.onHidden();
            } else if (document.visibilityState === "visible") {
                this.onVisible();
            }
        };
        this.pageHideListener = () => {
            void this.onHidden();
        };
        // Chromium-based WebViews fire a `freeze` event right before the
        // tab is suspended; use it as a last-chance flush.
        this.freezeListener = () => {
            void this.onHidden();
        };

        document.addEventListener("visibilitychange", this.visibilityListener);
        window.addEventListener("pagehide", this.pageHideListener);
        document.addEventListener("freeze", this.freezeListener);
    }

    unregister(): void {
        if (this.visibilityListener) {
            document.removeEventListener(
                "visibilitychange",
                this.visibilityListener
            );
            this.visibilityListener = undefined;
        }
        if (this.pageHideListener) {
            window.removeEventListener("pagehide", this.pageHideListener);
            this.pageHideListener = undefined;
        }
        if (this.freezeListener) {
            document.removeEventListener("freeze", this.freezeListener);
            this.freezeListener = undefined;
        }
        // Ensure no stale controller leaks across plugin reload.
        this.currentController?.abort();
        this.currentController = undefined;
        this.currentOp = undefined;
    }

    /**
     * Returns an {@link AbortSignal} threaded into the current op. The
     * caller must invoke {@link endOp} once the op resolves or rejects.
     */
    beginOp(op: MobileGitOp): AbortSignal {
        // If a previous op never released its controller (e.g. caller
        // forgot to call endOp), abort it before taking over so we never
        // leak handlers.
        this.currentController?.abort();
        this.currentController = new AbortController();
        this.currentOp = op;
        return this.currentController.signal;
    }

    endOp(op: MobileGitOp): void {
        if (this.currentOp !== op) return;
        this.currentController = undefined;
        this.currentOp = undefined;
    }

    isOpInFlight(): boolean {
        return this.currentOp !== undefined;
    }

    /**
     * Returns the {@link AbortSignal} for the currently running op, or
     * `undefined` if no op is in flight. Used by the isomorphic-git HTTP
     * client to early-reject requests after the WebView has been hidden.
     */
    currentSignal(): AbortSignal | undefined {
        return this.currentController?.signal;
    }

    private async onHidden(): Promise<void> {
        // Abort first so any in-flight HTTP wait is released as soon as
        // the underlying transport supports cancellation; flush after so
        // the cached index lands on disk regardless.
        this.currentController?.abort();
        try {
            await this.plugin.flushMobileState();
        } catch (e) {
            console.error("obsidian-git: flushMobileState failed", e);
        }
    }

    private onVisible(): void {
        this.plugin.automaticsManager.wake();
    }
}
