import type { DataAdapter } from "obsidian";
import type ObsidianGit from "../main";
import type { MobileGitOp } from "./lifecycleManager";

interface JournalEntry {
    op: MobileGitOp;
    startedAt: number;
    /**
     * Free-form info for the surfaced "interrupted op" notice.
     * E.g. the remote URL for a clone, or the branch for a pull.
     */
    detail?: string;
}

/**
 * Persists a single-entry "currently running git op" record to the plugin
 * data directory. Used to detect operations that were killed mid-flight
 * (iOS app suspension, OOM, manual force-quit) and surface a recovery
 * prompt the next time the plugin loads.
 *
 * Stored as a separate file (not the main settings JSON) so it can be
 * read/written independently of the rest of the settings save path and
 * is robust to a partial settings write.
 */
export class OperationJournal {
    private get adapter(): DataAdapter {
        return this.plugin.app.vault.adapter;
    }

    private get path(): string {
        return `${this.plugin.manifest.dir}/mobile-op-journal.json`;
    }

    constructor(private readonly plugin: ObsidianGit) {}

    async start(op: MobileGitOp, detail?: string): Promise<void> {
        const entry: JournalEntry = {
            op,
            startedAt: Date.now(),
            detail,
        };
        try {
            await this.adapter.write(this.path, JSON.stringify(entry));
        } catch (e) {
            console.error("obsidian-git: journal start failed", e);
        }
    }

    async end(op: MobileGitOp): Promise<void> {
        try {
            const existing = await this.read();
            // Only clear if this is the entry we wrote. A different op may
            // have started after a crash + reload; leaving its entry alone
            // means we still surface its interruption.
            if (existing && existing.op !== op) return;
            if (await this.adapter.exists(this.path)) {
                await this.adapter.remove(this.path);
            }
        } catch (e) {
            console.error("obsidian-git: journal end failed", e);
        }
    }

    /**
     * Returns the journal entry from a previous session if one exists.
     * The caller is responsible for deciding whether to surface it and for
     * clearing it via {@link clear} once the user has been notified.
     */
    async readPrevious(): Promise<JournalEntry | undefined> {
        return this.read();
    }

    async clear(): Promise<void> {
        try {
            if (await this.adapter.exists(this.path)) {
                await this.adapter.remove(this.path);
            }
        } catch (e) {
            console.error("obsidian-git: journal clear failed", e);
        }
    }

    private async read(): Promise<JournalEntry | undefined> {
        try {
            if (!(await this.adapter.exists(this.path))) return undefined;
            const raw = await this.adapter.read(this.path);
            return JSON.parse(raw) as JournalEntry;
        } catch (e) {
            console.error("obsidian-git: journal read failed", e);
            return undefined;
        }
    }
}
