/**
 * The NoDrive client handed to tools as ctx.nc (frozen interface, DESIGN 18.3): the low-level
 * client plus files primitives, sharees, capabilities, search providers and office conversion.
 */
import { type Capabilities, capabilities, navigationApps, searchProviders } from "./capabilities";
import { createNcClient, type NcClient, type NcOptions } from "./client";
import { type FilesApi, filesApi } from "./files";
import { officeConvert } from "./office";
import { type ShareesApi, shareesApi } from "./sharees";

export interface Nc extends NcClient {
	files: FilesApi;
	sharees: ShareesApi;
	capabilities(): Promise<Capabilities>;
	providers(): Promise<string[]>;
	navigationApps(): Promise<string[]>;
	officeConvert(fileId: number, ext: string, opts?: { timeoutMs?: number; maxBytes?: number }): Promise<Uint8Array>;
}

export function createNc(o: NcOptions): Nc {
	const base = createNcClient(o);
	const nc = base as Nc;
	nc.files = filesApi(base, o.cfg.driveOrigin);
	nc.sharees = shareesApi(base, { dev: o.cfg.env === "dev" });
	nc.capabilities = () => capabilities(base);
	nc.providers = () => searchProviders(base);
	nc.navigationApps = () => navigationApps(base);
	nc.officeConvert = (fileId, ext, opts) => officeConvert(base, fileId, ext, opts);
	return nc;
}

export type { CloudUser, NcClient, NcCredential, NcOptions, NcStats, RequestOptions } from "./client";
export type { DavResponse } from "./multistatus";
export { isCollection, key, NS, parseMultistatus, propEl, propHrefs, propText, XMLNS } from "./multistatus";
export { FILE_PROPS, type FileDetails, propfindBody, toFileDetails, toFileItem } from "./files";
export type { Sharee } from "./sharees";
export type { Capabilities } from "./capabilities";
