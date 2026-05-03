/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/only-throw-error */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DataAdapter, Vault } from "obsidian";
import { normalizePath, Platform, TFile } from "obsidian";
import type ObsidianGit from "../main";

export class MyAdapter {
    promises: any = {};
    adapter: DataAdapter;
    vault: Vault;
    index: ArrayBuffer | undefined;
    indexctime: number | undefined;
    indexmtime: number | undefined;
    indexDirty = false;
    lastBasePath: string | undefined;

    constructor(
        vault: Vault,
        private readonly plugin: ObsidianGit
    ) {
        this.adapter = vault.adapter;
        this.vault = vault;
        this.lastBasePath = this.plugin.settings.basePath;

        this.promises.readFile = this.readFile.bind(this);
        this.promises.writeFile = this.writeFile.bind(this);
        this.promises.readdir = this.readdir.bind(this);
        this.promises.mkdir = this.mkdir.bind(this);
        this.promises.rmdir = this.rmdir.bind(this);
        this.promises.stat = this.stat.bind(this);
        this.promises.unlink = this.unlink.bind(this);
        this.promises.lstat = this.lstat.bind(this);
        this.promises.readlink = this.readlink.bind(this);
        this.promises.symlink = this.symlink.bind(this);
    }
    async readFile(path: string, opts: any) {
        this.maybeLog("Read: " + path + JSON.stringify(opts));
        if (opts == "utf8" || opts.encoding == "utf8") {
            const file = this.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                this.maybeLog("Reuse");

                return this.vault.read(file);
            } else {
                return this.adapter.read(path);
            }
        } else {
            if (path.endsWith(this.gitDir + "/index")) {
                if (this.plugin.settings.basePath != this.lastBasePath) {
                    this.clearIndex();
                    this.lastBasePath = this.plugin.settings.basePath;
                    return this.adapter.readBinary(path);
                }
                return this.index ?? this.adapter.readBinary(path);
            }
            const file = this.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                this.maybeLog("Reuse");

                return this.vault.readBinary(file);
            } else {
                return this.adapter.readBinary(path);
            }
        }
    }
    async writeFile(path: string, data: string | ArrayBuffer) {
        this.maybeLog("Write: " + path);

        if (typeof data === "string") {
            const file = this.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                return this.vault.modify(file, data);
            } else {
                return this.adapter.write(path, data);
            }
        } else {
            if (path.endsWith(this.gitDir + "/index")) {
                this.index = data;
                this.indexmtime = Date.now();
                this.indexDirty = true;
                // The cached index is persisted via flushIndex() — at
                // op end through saveAndClear, and on
                // visibilitychange/pagehide via the mobile lifecycle
                // manager. Eager per-mutation writes were measured to
                // cause N writes per checkout-of-N-files and have been
                // intentionally avoided.
            } else {
                const file = this.vault.getAbstractFileByPath(path);
                if (file instanceof TFile) {
                    return this.vault.modifyBinary(file, data);
                } else {
                    return this.adapter.writeBinary(path, data);
                }
            }
        }
    }
    async readdir(path: string) {
        if (path === ".") path = "/";
        const res = await this.adapter.list(path);
        const all = [...res.files, ...res.folders];
        let formattedAll;
        if (path !== "/") {
            formattedAll = all.map((e) =>
                normalizePath(e.substring(path.length))
            );
        } else {
            formattedAll = all;
        }
        return formattedAll;
    }
    async mkdir(path: string) {
        return this.adapter.mkdir(path);
    }
    async rmdir(path: string, opts: any) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        return this.adapter.rmdir(path, opts?.options?.recursive ?? false);
    }
    async stat(path: string) {
        if (path.endsWith(this.gitDir + "/index")) {
            if (
                this.index !== undefined &&
                this.indexctime != undefined &&
                this.indexmtime != undefined
            ) {
                return {
                    isFile: () => true,
                    isDirectory: () => false,
                    isSymbolicLink: () => false,
                    size: this.index.byteLength,
                    type: "file",
                    ctimeMs: this.indexctime,
                    mtimeMs: this.indexmtime,
                };
            } else {
                const stat = await this.adapter.stat(path);
                if (stat == undefined) {
                    throw { code: "ENOENT" };
                }
                this.indexctime = stat.ctime;
                this.indexmtime = stat.mtime;
                return {
                    ctimeMs: stat.ctime,
                    mtimeMs: stat.mtime,
                    size: stat.size,
                    type: "file",
                    isFile: () => true,
                    isDirectory: () => false,
                    isSymbolicLink: () => false,
                };
            }
        }
        if (path === ".") path = "/";
        const file = this.vault.getAbstractFileByPath(path);
        this.maybeLog("Stat: " + path);
        if (file instanceof TFile) {
            this.maybeLog("Reuse stat");
            return {
                ctimeMs: file.stat.ctime,
                mtimeMs: file.stat.mtime,
                size: file.stat.size,
                type: "file",
                isFile: () => true,
                isDirectory: () => false,
                isSymbolicLink: () => false,
            };
        } else {
            const stat = await this.adapter.stat(path);
            if (stat) {
                return {
                    ctimeMs: stat.ctime,
                    mtimeMs: stat.mtime,
                    size: stat.size,
                    type: stat.type === "folder" ? "directory" : stat.type,
                    isFile: () => stat.type === "file",
                    isDirectory: () => stat.type === "folder",
                    isSymbolicLink: () => false,
                };
            } else {
                // used to determine whether a file exists or not
                throw { code: "ENOENT" };
            }
        }
    }
    async unlink(path: string) {
        return this.adapter.remove(path);
    }
    async lstat(path: string) {
        return this.stat(path);
    }
    async readlink(path: string) {
        throw new Error(`readlink of (${path}) is not implemented.`);
    }
    async symlink(path: string) {
        throw new Error(`symlink of (${path}) is not implemented.`);
    }

    async saveAndClear(): Promise<void> {
        await this.flushIndex();
        this.clearIndex();
    }

    /**
     * Persist the cached `.git/index` to disk without dropping the cache.
     * Safe to call repeatedly (no-op if the cache is clean).
     *
     * Uses an atomic `.git/index.tmp -> rename` when mobile hardening is
     * enabled so an interrupted write (e.g. iOS WebView suspension) cannot
     * leave a torn index. {@link recoverIndex} repairs the half-state on
     * the next launch.
     */
    async flushIndex(): Promise<void> {
        if (this.index === undefined || !this.indexDirty) return;

        const indexPath = this.plugin.gitManager.getRelativeVaultPath(
            this.gitDir + "/index"
        );

        if (this.shouldHardenIndexWrites()) {
            const tmpPath = indexPath + ".tmp";
            await this.adapter.writeBinary(tmpPath, this.index, {
                ctime: this.indexctime,
                mtime: this.indexmtime,
            });
            try {
                await this.adapter.rename(tmpPath, indexPath);
            } catch {
                // Most adapters do not overwrite on rename. Remove the
                // stale index and retry. If the second rename also fails,
                // recoverIndex() on next launch will pick up the .tmp.
                try {
                    await this.adapter.remove(indexPath);
                } catch {
                    // ignore — file may not exist
                }
                await this.adapter.rename(tmpPath, indexPath);
            }
        } else {
            await this.adapter.writeBinary(indexPath, this.index, {
                ctime: this.indexctime,
                mtime: this.indexmtime,
            });
        }
        this.indexDirty = false;
    }

    clearIndex() {
        this.index = undefined;
        this.indexctime = undefined;
        this.indexmtime = undefined;
        this.indexDirty = false;
    }

    /**
     * Repair an interrupted index write. Should run before any git op
     * after plugin start. If `.git/index.tmp` exists and `.git/index`
     * does not, the tmp file is the most recent good copy and is
     * promoted. If both exist, the live index is treated as authoritative
     * and the tmp is removed.
     */
    async recoverIndex(): Promise<void> {
        if (!this.shouldHardenIndexWrites()) return;
        const indexPath = this.plugin.gitManager.getRelativeVaultPath(
            this.gitDir + "/index"
        );
        const tmpPath = indexPath + ".tmp";
        const tmpExists = await this.adapter.exists(tmpPath);
        if (!tmpExists) return;
        const indexExists = await this.adapter.exists(indexPath);
        if (!indexExists) {
            await this.adapter.rename(tmpPath, indexPath);
        } else {
            try {
                await this.adapter.remove(tmpPath);
            } catch {
                // ignore
            }
        }
    }

    private shouldHardenIndexWrites(): boolean {
        return this.plugin.settings.mobileHardening && !Platform.isDesktopApp;
    }

    private get gitDir(): string {
        return this.plugin.settings.gitDir || ".git";
    }

    private maybeLog(_: string) {
        // console.log(text);
    }
}
