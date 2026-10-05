export interface CacheStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  keys(): Promise<string[]>;
  /** The stored text with its precomputed ETag, when the store keeps one. */
  getWithEtag?(key: string): Promise<{ value: string; etag?: string } | undefined>;
  /** Store with an ETag computed by the caller, sparing every hit a body hash. */
  setWithEtag?(key: string, value: string, etag: string): Promise<void>;
}
