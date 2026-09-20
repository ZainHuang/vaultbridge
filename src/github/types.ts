export interface RepositoryTarget { owner: string; repository: string; branch: string }
export interface RemoteEntry { path: string; sha: string; type: 'blob' | 'tree' | 'commit'; mode: string; size?: number }
export interface RemoteSnapshot {
  remoteHeadSha: string;
  treeSha: string;
  entries: RemoteEntry[];
  fetchedAt: string;
}
export interface GetRequest { url: string; method: 'GET'; headers: Record<string, string>; throw: false }
export interface GetResponse { status: number; json: unknown }
export type GetTransport = (request: GetRequest) => Promise<GetResponse>;
export interface GitRequest { url: string; method: 'GET' | 'POST' | 'PATCH'; headers: Record<string, string>; throw: false; body?: string }
export type GitTransport = (request: GitRequest) => Promise<GetResponse>;
