use crate::bridge::MountPluginContext;
use crate::protocol::{
    JsBridgeCallRequest, JsBridgeResultResponse, OwnershipScope, SidecarRequestPayload,
    SidecarResponsePayload,
};
use crate::SidecarError;

use agentos_kernel::mount_plugin::{
    FileSystemPluginFactory, OpenFileSystemPluginRequest, PluginError,
};
use agentos_kernel::mount_table::{MountedFileSystem, MountedVirtualFileSystem};
use agentos_kernel::vfs::{VfsError, VfsResult, VirtualDirEntry, VirtualFileSystem, VirtualStat};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const JS_BRIDGE_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsBridgeMountConfig {
    #[serde(default)]
    mount_id: Option<String>,
}

#[derive(Debug)]
pub(crate) struct JsBridgeMountPlugin;

impl<B> FileSystemPluginFactory<MountPluginContext<B>> for JsBridgeMountPlugin {
    fn plugin_id(&self) -> &'static str {
        "js_bridge"
    }

    fn open(
        &self,
        request: OpenFileSystemPluginRequest<'_, MountPluginContext<B>>,
    ) -> Result<Box<dyn MountedFileSystem>, PluginError> {
        let config: JsBridgeMountConfig = match &request.config {
            Value::Null => JsBridgeMountConfig::default(),
            Value::Object(_) => serde_json::from_value(request.config.clone())
                .map_err(|error| PluginError::invalid_input(error.to_string()))?,
            _ => {
                return Err(PluginError::invalid_input(
                    "js_bridge mount config must be an object or null",
                ));
            }
        };
        let mount_id = config
            .mount_id
            .unwrap_or_else(|| request.guest_path.to_owned());
        let ownership = OwnershipScope::vm(
            request.context.connection_id.clone(),
            request.context.session_id.clone(),
            request.context.vm_id.clone(),
        );

        Ok(Box::new(MountedVirtualFileSystem::new(
            JsBridgeFilesystem::new(
                request.context.sidecar_requests.clone(),
                ownership,
                mount_id,
                request.context.max_pread_bytes,
            ),
        )))
    }
}

/// Environment variable that sets the lifetime, in milliseconds, of cached
/// `stat`, `lstat`, `realpath` and `exists` answers. Unset or `0` disables the
/// cache.
const JS_BRIDGE_ATTR_CACHE_ENV: &str = "AGENTOS_JS_BRIDGE_ATTR_CACHE_MS";
const JS_BRIDGE_ATTR_CACHE_MAX_ENTRIES: usize = 65_536;

#[derive(Clone)]
enum CachedAttr {
    Stat(VirtualStat),
    Path(String),
    Missing(VfsError),
}

/// Short-lived metadata cache for one js_bridge mount. The kernel resolves the
/// subject of each guest syscall through `realpath` and `stat`, so one file
/// access repeats the same host callbacks dozens of times. A local mutation
/// clears the cache; the lifetime bounds staleness for host-side changes.
#[derive(Default)]
struct AttrCache {
    entries: HashMap<(&'static str, String), (Instant, CachedAttr)>,
}

fn attr_cache_ttl() -> Option<Duration> {
    std::env::var(JS_BRIDGE_ATTR_CACHE_ENV)
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .filter(|millis| *millis > 0)
        .map(Duration::from_millis)
}

#[derive(Clone)]
struct JsBridgeFilesystem {
    attr_cache: Arc<Mutex<AttrCache>>,
    attr_cache_ttl: Option<Duration>,
    requests: crate::state::SharedSidecarRequestClient,
    ownership: OwnershipScope,
    mount_id: String,
    next_call_id: Arc<AtomicU64>,
    max_read_bytes: Option<usize>,
}

impl JsBridgeFilesystem {
    fn new(
        requests: crate::state::SharedSidecarRequestClient,
        ownership: OwnershipScope,
        mount_id: String,
        max_read_bytes: Option<usize>,
    ) -> Self {
        Self {
            attr_cache: Arc::new(Mutex::new(AttrCache::default())),
            attr_cache_ttl: attr_cache_ttl(),
            requests,
            ownership,
            mount_id,
            next_call_id: Arc::new(AtomicU64::new(1)),
            max_read_bytes,
        }
    }

    fn cached_attr(&self, operation: &'static str, path: &str) -> Option<CachedAttr> {
        let ttl = self.attr_cache_ttl?;
        let cache = self.attr_cache.lock().ok()?;
        let (at, attr) = cache.entries.get(&(operation, path.to_owned()))?;
        (at.elapsed() < ttl).then(|| attr.clone())
    }

    fn store_attr(&self, operation: &'static str, path: &str, attr: CachedAttr) {
        if self.attr_cache_ttl.is_none() {
            return;
        }
        if let Ok(mut cache) = self.attr_cache.lock() {
            if cache.entries.len() >= JS_BRIDGE_ATTR_CACHE_MAX_ENTRIES {
                cache.entries.clear();
            }
            cache
                .entries
                .insert((operation, path.to_owned()), (Instant::now(), attr));
        }
    }

    fn invalidate_attrs(&self) {
        if self.attr_cache_ttl.is_none() {
            return;
        }
        if let Ok(mut cache) = self.attr_cache.lock() {
            cache.entries.clear();
        }
    }

    fn cached_stat(&self, operation: &'static str, path: &str) -> VfsResult<VirtualStat> {
        match self.cached_attr(operation, path) {
            Some(CachedAttr::Stat(stat)) => return Ok(stat),
            Some(CachedAttr::Missing(error)) => return Err(error),
            _ => {}
        }
        let fetched = self
            .request_path(operation, path, json!({ "path": path }))
            .and_then(|result| {
                self.parse_required::<JsBridgeVirtualStat>(operation, path, result)
            });
        match fetched {
            Ok(stat) => {
                let stat: VirtualStat = stat.into();
                self.store_attr(operation, path, CachedAttr::Stat(stat.clone()));
                Ok(stat)
            }
            Err(error) => {
                if error.code() == "ENOENT" {
                    self.store_attr(operation, path, CachedAttr::Missing(error.clone()));
                }
                Err(error)
            }
        }
    }

    fn next_call_id(&self) -> String {
        format!(
            "js-bridge-call-{}",
            self.next_call_id.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn request_path(&self, operation: &str, path: &str, args: Value) -> VfsResult<Option<Value>> {
        let args = serde_json::to_string(&args).map_err(|error| {
            VfsError::io(format!(
                "failed to encode js_bridge args for {operation} '{path}': {error}"
            ))
        })?;
        let payload = SidecarRequestPayload::JsBridgeCall(JsBridgeCallRequest {
            call_id: self.next_call_id(),
            mount_id: self.mount_id.clone(),
            operation: operation.to_owned(),
            args,
        });
        match self
            .requests
            .invoke(self.ownership.clone(), payload, JS_BRIDGE_TIMEOUT)
            .map_err(|error| Self::sidecar_error_to_vfs(operation, path, error))?
        {
            SidecarResponsePayload::JsBridgeResult(JsBridgeResultResponse {
                result,
                error,
                ..
            }) => {
                if let Some(error) = error {
                    return Err(Self::js_error_to_vfs(operation, path, &error));
                }
                result
                    .map(|result| {
                        serde_json::from_str(&result).map_err(|error| {
                            VfsError::io(format!(
                                "invalid js_bridge result payload for {operation} '{path}': {error}"
                            ))
                        })
                    })
                    .transpose()
            }
            other => Err(VfsError::io(format!(
                "unexpected js_bridge response payload: {other:?}"
            ))),
        }
    }

    fn sidecar_error_to_vfs(operation: &str, path: &str, error: SidecarError) -> VfsError {
        match error {
            SidecarError::Io(message) if message.contains("timed out") => {
                VfsError::io(format!("{operation} {path}: {message}"))
            }
            other => VfsError::io(format!("{operation} {path}: {other}")),
        }
    }

    fn js_error_to_vfs(operation: &str, path: &str, error: &str) -> VfsError {
        let lower = error.to_ascii_lowercase();
        let code = if lower.contains("enoent")
            || lower.contains("not found")
            || lower.contains("no such file")
        {
            "ENOENT"
        } else if lower.contains("eacces")
            || lower.contains("eperm")
            || lower.contains("permission denied")
        {
            "EACCES"
        } else if lower.contains("eexist") || lower.contains("already exists") {
            "EEXIST"
        } else {
            "EIO"
        };
        VfsError::new(code, format!("{error}, {operation} '{path}'"))
    }

    fn parse_required<T>(&self, operation: &str, path: &str, result: Option<Value>) -> VfsResult<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let value = result.ok_or_else(|| {
            VfsError::io(format!(
                "js_bridge returned no payload for {operation} '{path}'"
            ))
        })?;
        serde_json::from_value(value).map_err(|error| {
            VfsError::io(format!(
                "invalid js_bridge payload for {operation} '{path}': {error}"
            ))
        })
    }

    fn parse_bytes(
        &self,
        operation: &str,
        path: &str,
        result: Option<Value>,
    ) -> VfsResult<Vec<u8>> {
        self.parse_bytes_limited(operation, path, result, None)
    }

    fn parse_bytes_limited(
        &self,
        operation: &str,
        path: &str,
        result: Option<Value>,
        operation_max_bytes: Option<usize>,
    ) -> VfsResult<Vec<u8>> {
        let max_bytes = effective_read_limit(self.max_read_bytes, operation_max_bytes);
        match result.ok_or_else(|| {
            VfsError::io(format!(
                "js_bridge returned no payload for {operation} '{path}'"
            ))
        })? {
            Value::String(encoded) => {
                let estimated_len = estimated_base64_decoded_len(&encoded).ok_or_else(|| {
                    VfsError::io(format!(
                        "js_bridge base64 payload length overflows for {operation} '{path}'"
                    ))
                })?;
                Self::check_read_length(operation, path, estimated_len, max_bytes)?;
                let decoded = BASE64_STANDARD.decode(encoded).map_err(|error| {
                    VfsError::io(format!(
                        "invalid js_bridge base64 payload for {operation} '{path}': {error}"
                    ))
                })?;
                Self::check_read_length(operation, path, decoded.len(), max_bytes)?;
                Ok(decoded)
            }
            Value::Array(values) => {
                Self::check_read_length(operation, path, values.len(), max_bytes)?;
                values
                    .into_iter()
                    .map(|value| match value {
                        Value::Number(number) => number
                            .as_u64()
                            .and_then(|value| u8::try_from(value).ok())
                            .ok_or_else(|| {
                                VfsError::io(format!(
                                    "invalid js_bridge byte payload for {operation} '{path}'"
                                ))
                            }),
                        _ => Err(VfsError::io(format!(
                            "invalid js_bridge byte payload for {operation} '{path}'"
                        ))),
                    })
                    .collect()
            }
            other => Err(VfsError::io(format!(
                "unsupported js_bridge payload for {operation} '{path}': {other:?}"
            ))),
        }
    }

    fn check_read_length(
        operation: &str,
        path: &str,
        length: usize,
        max_bytes: Option<usize>,
    ) -> VfsResult<()> {
        if let Some(limit) = max_bytes {
            if length <= limit {
                return Ok(());
            }

            return Err(VfsError::new(
                "EINVAL",
                format!(
                    "js_bridge payload length {length} exceeds configured read limit {limit}, {operation} '{path}'"
                ),
            ));
        }

        Ok(())
    }
}

fn effective_read_limit(
    mount_max_bytes: Option<usize>,
    operation_max_bytes: Option<usize>,
) -> Option<usize> {
    match (mount_max_bytes, operation_max_bytes) {
        (Some(left), Some(right)) => Some(left.min(right)),
        (Some(limit), None) | (None, Some(limit)) => Some(limit),
        (None, None) => None,
    }
}

fn estimated_base64_decoded_len(encoded: &str) -> Option<usize> {
    let padding = encoded
        .as_bytes()
        .iter()
        .rev()
        .take_while(|byte| **byte == b'=')
        .count()
        .min(2);
    encoded
        .len()
        .checked_add(3)
        .map(|length| (length / 4).saturating_mul(3).saturating_sub(padding))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsBridgeVirtualStat {
    mode: u32,
    size: u64,
    blocks: u64,
    dev: u64,
    rdev: u64,
    #[serde(alias = "is_directory")]
    is_directory: bool,
    #[serde(alias = "is_symbolic_link")]
    is_symbolic_link: bool,
    #[serde(alias = "atime_ms")]
    atime_ms: u64,
    #[serde(default, alias = "atime_nsec")]
    atime_nsec: u32,
    #[serde(alias = "mtime_ms")]
    mtime_ms: u64,
    #[serde(default, alias = "mtime_nsec")]
    mtime_nsec: u32,
    #[serde(alias = "ctime_ms")]
    ctime_ms: u64,
    #[serde(default, alias = "ctime_nsec")]
    ctime_nsec: u32,
    #[serde(alias = "birthtime_ms")]
    birthtime_ms: u64,
    ino: u64,
    nlink: u64,
    uid: u32,
    gid: u32,
}

/// Mask of the POSIX file-type bits within `st_mode`.
const S_IFMT: u32 = 0o170000;
const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;

impl JsBridgeVirtualStat {
    /// Bridge backends (e.g. a callback-backed durable-storage fs) may send
    /// permission-only `mode` values and carry the entry type in the
    /// `isDirectory` / `isSymbolicLink` booleans. Guest-facing consumers
    /// (WASI filestat, Node `Stats.isFile()`) derive the type from `S_IFMT`
    /// bits, so a bare permission mode reads as "unknown filetype" and breaks
    /// `cat`/`cd`/`ls` on mount-backed paths. Normalize by deriving the type
    /// bits from the booleans whenever the backend omitted them.
    fn normalized_mode(&self) -> u32 {
        if self.mode & S_IFMT != 0 {
            return self.mode;
        }
        let type_bits = if self.is_symbolic_link {
            S_IFLNK
        } else if self.is_directory {
            S_IFDIR
        } else {
            S_IFREG
        };
        type_bits | self.mode
    }
}

impl From<JsBridgeVirtualStat> for VirtualStat {
    fn from(stat: JsBridgeVirtualStat) -> Self {
        Self {
            mode: stat.normalized_mode(),
            size: stat.size,
            blocks: stat.blocks,
            dev: stat.dev,
            rdev: stat.rdev,
            is_directory: stat.is_directory,
            is_symbolic_link: stat.is_symbolic_link,
            atime_ms: stat.atime_ms,
            atime_nsec: stat.atime_nsec,
            mtime_ms: stat.mtime_ms,
            mtime_nsec: stat.mtime_nsec,
            ctime_ms: stat.ctime_ms,
            ctime_nsec: stat.ctime_nsec,
            birthtime_ms: stat.birthtime_ms,
            ino: stat.ino,
            nlink: stat.nlink,
            uid: stat.uid,
            gid: stat.gid,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct JsBridgeDirEntry {
    name: String,
    #[serde(alias = "is_directory")]
    is_directory: bool,
    #[serde(alias = "is_symbolic_link")]
    is_symbolic_link: bool,
}

impl From<JsBridgeDirEntry> for VirtualDirEntry {
    fn from(entry: JsBridgeDirEntry) -> Self {
        Self {
            name: entry.name,
            is_directory: entry.is_directory,
            is_symbolic_link: entry.is_symbolic_link,
        }
    }
}

impl VirtualFileSystem for JsBridgeFilesystem {
    fn read_file(&mut self, path: &str) -> VfsResult<Vec<u8>> {
        let result = self.request_path("readFile", path, json!({ "path": path }))?;
        self.parse_bytes("readFile", path, result)
    }

    fn read_dir(&mut self, path: &str) -> VfsResult<Vec<String>> {
        self.parse_required(
            "readDir",
            path,
            self.request_path("readDir", path, json!({ "path": path }))?,
        )
    }

    fn read_dir_with_types(&mut self, path: &str) -> VfsResult<Vec<VirtualDirEntry>> {
        let entries: Vec<JsBridgeDirEntry> = self.parse_required(
            "readDirWithTypes",
            path,
            self.request_path("readDirWithTypes", path, json!({ "path": path }))?,
        )?;
        Ok(entries.into_iter().map(Into::into).collect())
    }

    fn write_file(&mut self, path: &str, content: impl Into<Vec<u8>>) -> VfsResult<()> {
        let content = BASE64_STANDARD.encode(content.into());
        self.invalidate_attrs();
        self.request_path(
            "writeFile",
            path,
            json!({
                "path": path,
                "content": content,
            }),
        )?;
        Ok(())
    }

    fn create_dir(&mut self, path: &str) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path("createDir", path, json!({ "path": path }))?;
        Ok(())
    }

    fn mkdir(&mut self, path: &str, recursive: bool) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path(
            "mkdir",
            path,
            json!({
                "path": path,
                "recursive": recursive,
            }),
        )?;
        Ok(())
    }

    fn exists(&self, path: &str) -> bool {
        // `VirtualFileSystem::exists` cannot carry an error and Node's
        // `existsSync` reports any failure as `false`, so a failed host callback
        // (EIO, timeout) still answers `false`. Log it here so an I/O failure is
        // not mistaken for a missing file.
        match self.cached_attr("stat", path) {
            Some(CachedAttr::Stat(_)) => return true,
            Some(CachedAttr::Missing(_)) => return false,
            _ => {}
        }
        match self.request_path("exists", path, json!({ "path": path })) {
            Ok(Some(Value::Bool(exists))) => {
                if !exists {
                    self.store_attr(
                        "stat",
                        path,
                        CachedAttr::Missing(VfsError::new(
                            "ENOENT",
                            format!("no such file or directory, stat '{path}'"),
                        )),
                    );
                }
                exists
            }
            Ok(other) => {
                tracing::warn!(
                    mount_id = %self.mount_id,
                    path,
                    payload = ?other,
                    "js_bridge exists returned a non-boolean payload; reporting false"
                );
                false
            }
            Err(error) if error.code() == "ENOENT" => false,
            Err(error) => {
                tracing::warn!(
                    mount_id = %self.mount_id,
                    path,
                    %error,
                    "js_bridge exists failed; reporting false to the guest"
                );
                false
            }
        }
    }

    fn stat(&mut self, path: &str) -> VfsResult<VirtualStat> {
        self.cached_stat("stat", path)
    }

    fn remove_file(&mut self, path: &str) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path("removeFile", path, json!({ "path": path }))?;
        Ok(())
    }

    fn remove_dir(&mut self, path: &str) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path("removeDir", path, json!({ "path": path }))?;
        Ok(())
    }

    fn rename(&mut self, old_path: &str, new_path: &str) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path(
            "rename",
            old_path,
            json!({
                "oldPath": old_path,
                "newPath": new_path,
            }),
        )?;
        Ok(())
    }

    fn realpath(&self, path: &str) -> VfsResult<String> {
        // The mount root always exists — it IS the mount point — so resolve it
        // locally like `host_dir` does instead of round-tripping the bridge.
        // Host-side drivers frequently cannot canonicalize their own root and
        // return ENOENT for it, and because a js_bridge mount root is not a
        // symlink leaf, `MountTable::realpath` propagates that ENOENT instead
        // of falling back to the lexical path. The kernel permission wrapper
        // resolves every operation's subject through `realpath` first, so that
        // ENOENT aborts e.g. a readdir of the mount root before the readDir
        // bridge call is ever issued.
        if path.is_empty() || path == "/" {
            return Ok(String::from("/"));
        }
        match self.cached_attr("realpath", path) {
            Some(CachedAttr::Path(resolved)) => return Ok(resolved),
            Some(CachedAttr::Missing(error)) => return Err(error),
            _ => {}
        }
        let fetched = self
            .request_path("realpath", path, json!({ "path": path }))
            .and_then(|result| self.parse_required::<String>("realpath", path, result));
        match fetched {
            Ok(resolved) => {
                self.store_attr("realpath", path, CachedAttr::Path(resolved.clone()));
                Ok(resolved)
            }
            Err(error) => {
                if error.code() == "ENOENT" {
                    self.store_attr("realpath", path, CachedAttr::Missing(error.clone()));
                }
                Err(error)
            }
        }
    }

    fn symlink(&mut self, target: &str, link_path: &str) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path(
            "symlink",
            link_path,
            json!({
                "target": target,
                "linkPath": link_path,
            }),
        )?;
        Ok(())
    }

    fn read_link(&self, path: &str) -> VfsResult<String> {
        self.parse_required(
            "readlink",
            path,
            self.request_path("readlink", path, json!({ "path": path }))?,
        )
    }

    fn lstat(&self, path: &str) -> VfsResult<VirtualStat> {
        self.cached_stat("lstat", path)
    }

    fn link(&mut self, old_path: &str, new_path: &str) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path(
            "link",
            old_path,
            json!({
                "oldPath": old_path,
                "newPath": new_path,
            }),
        )?;
        Ok(())
    }

    fn chmod(&mut self, path: &str, mode: u32) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path(
            "chmod",
            path,
            json!({
                "path": path,
                "mode": mode,
            }),
        )?;
        Ok(())
    }

    fn chown(&mut self, path: &str, uid: u32, gid: u32) -> VfsResult<()> {
        self.chown_spec(path, uid, gid, true)
    }

    fn chown_spec(
        &mut self,
        path: &str,
        uid: u32,
        gid: u32,
        follow_symlinks: bool,
    ) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path(
            "chown",
            path,
            json!({
                "path": path,
                "uid": uid,
                "gid": gid,
                "followSymlinks": follow_symlinks,
            }),
        )?;
        Ok(())
    }

    fn utimes(&mut self, path: &str, atime_ms: u64, mtime_ms: u64) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path(
            "utimes",
            path,
            json!({
                "path": path,
                "atimeMs": atime_ms,
                "mtimeMs": mtime_ms,
            }),
        )?;
        Ok(())
    }

    fn truncate(&mut self, path: &str, length: u64) -> VfsResult<()> {
        self.invalidate_attrs();
        self.request_path(
            "truncate",
            path,
            json!({
                "path": path,
                "length": length,
            }),
        )?;
        Ok(())
    }

    fn pread(&mut self, path: &str, offset: u64, length: usize) -> VfsResult<Vec<u8>> {
        let result = self.request_path(
            "pread",
            path,
            json!({
                "path": path,
                "offset": offset,
                "length": length,
            }),
        )?;
        self.parse_bytes_limited("pread", path, result, Some(length))
    }

    fn pwrite(&mut self, path: &str, content: impl Into<Vec<u8>>, offset: u64) -> VfsResult<()> {
        let content = BASE64_STANDARD.encode(content.into());
        self.invalidate_attrs();
        self.request_path(
            "pwrite",
            path,
            json!({
                "path": path,
                "offset": offset,
                "content": content,
            }),
        )?;
        Ok(())
    }
}
