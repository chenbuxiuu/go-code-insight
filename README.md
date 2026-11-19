# Go Code Insight

Go CodeLens for workspace and dependency code, plus variable values inline while debugging.
Go 代码的 CodeLens（覆盖工作区与依赖包），以及调试时的内联变量值。

**[English](#english) · [中文](#中文)**

---

## English

### Features

#### 1. CodeLens — workspace and dependencies

```go
no imports                                              ← package clause: files importing it
package t

1 ref | 3 implementations                               ← interface: implementations
type Shape interface {
    0 refs | 3 implementations                          ← interface method: implementations
    Area() float64
}

4 refs | implements Shape, fmt.Stringer, io.Reader | 3 methods
type Sq struct {
    2 refs                                              ← struct field references
    side float64
}

0 refs | implements io.Reader.Read                      ← which interface method a method implements
func (q *Sq) Read(p []byte) (int, error) { ... }
```

| Where | Lens | Click |
| --- | --- | --- |
| package clause | `N imports` (files importing the package) | peek list |
| interface / interface method | `N implementations` (concrete types only) | jump if one, peek if several |
| struct / named type | `implements A, pkg.B, …` (incl. stdlib and dependency interfaces), `N methods` | same |
| method | `implements io.Reader.Read` | jump to the interface method |
| type / func / method / field | `N refs` | peek references |

Types and methods that implement nothing get no `implements` lens; embedded fields and fields of single-line structs get no field lens.

**Lenses in dependencies** (`goCodeInsight.dependencies.enable`):
- **Module-cache dependencies** (`…/pkg/mod/x@v1.2.3`): the bundled indexer (`indexer/main.go`, one `go/types` pass over the module) builds a cross-reference index once per module version. It is stored in `~/Library/Caches/go-code-insight` (Linux `~/.cache`, Windows `%LOCALAPPDATA%`), shared by every window, and read from disk afterwards — no language server. Results are merged with references from your workspace; counts match gopls (verified on a 97-package module: 549/549 declarations for references, 71/71 for implementations).
- Ten seconds after startup, dependency modules of the **same organization** as your workspace module are indexed in the background (`goCodeInsight.dependencies.prebuild`: `sameOrg` / `all` / `off`), once per module version.
- **Other repositories** (mutable directories): a gopls rooted at that module is started on demand (see resource limits below).
- Standard library: only your workspace is searched, shown as `N refs (in <workspace>)`.

#### 2. Inline values while debugging

When a Go debug session (dlv, via the Go extension) stops, every line of the current function up to the stop line shows `name = value` for the variables and parameters it mentions:

```go
func describe(prefix string, n int) string {      prefix = "p", n = 7
	total := 0                                     total = 1
	parts := []string{prefix}                      parts = []string len: 1, cap: 1, ["p"], prefix = "p"
	for i, w := range []string{"a", "bb"} {        i = 0, w = "a"
		total += i + len(w)                         total = 1, i = 0, w = "a"
		parts = append(parts, w)  ◀ stopped here    parts = []string len: 1, cap: 1, ["p"], w = "a"
```

- Scopes follow Go's rules: `if`/`for`/`switch` header variables, `for range` variables only inside the loop, closure parameters and captured variables, shadowing. Comments, strings, composite-literal keys and `x.field` selectors are never annotated.
- Values come from the debugger: two DAP requests (`scopes` + `variables`) per stop, cached for that stop.
- Overly complex values are hidden: structs / slices / maps longer than `goCodeInsight.inlineValues.maxLength` (default 50); long scalars are truncated.
- Requires the VS Code setting `debug.inlineValues` to be `auto` (default) or `on`.

### Requirements

- The Go extension (`golang.go`) with gopls enabled (the default). Workspace queries reuse its gopls.
- The dependency index needs the Go toolchain (the indexer is compiled once, ~1 s, and cached in the directory above).

### Refreshing

- The edited file is recomputed automatically; other visible Go editors refresh `refreshDelay` ms after you stop typing.
- Edits that only touch comments, blank lines or formatting trigger no new queries (token-level hash); cached positions are just shifted.
- `*.go`, `go.mod` and `go.work` changes on disk also refresh. Commands: `Go Code Insight: Toggle Lenses` / `Refresh Lenses`.

### Performance and resources

Measured against Tooltitude for Go (same machine, isolated VS Code instances, a multi-module business workspace, opening a file of a dependency module from the module cache, a function with 67 references):

| | Tooltitude | Go Code Insight |
| --- | --- | --- |
| Dependency file opened → a count is shown | 0.1–0.7 s | 0.2–0.3 s (the module's count first: `65 refs …`) |
| Exact count (including workspace references) | 0.1–0.7 s | gopls running: 0.8 s; gopls just starting: 1.2–1.4 s |
| Resident extra process | one per window, ~300 MB, 3.3–5.2 s CPU at startup | none (index on disk, shared by all windows) |
| Index build | on every window start | once per module version: a 97-package module ~0.5–1 s, ~80 MB peak, then the process exits |
| Debugger inline values | paid feature, needs the resident process | 1–7 ms per stop (2 DAP requests), no extra process |

Workspace references to a dependency come from the Go extension's gopls, which has to load the dependency package after the file opens — hence the slightly later exact count; Tooltitude keeps that part in its resident in-memory index.

- **No resident extra process**: workspace queries use the Go extension's gopls; dependencies use the on-disk index (the indexer exits when done); inline values are computed inside the extension host.
- **Local parsing instead of gopls requests**: symbol extraction (identical to gopls documentSymbol on 167 files, ~0.16 ms per file), method counts, comment-only edit detection and debugger scope analysis run locally.
- **On demand and throttled**: reference / implementation counts are only queried for lenses in view; `implements` costs one request per type and only within ±100 lines of the viewport; at most `maxConcurrentRequests` concurrent requests; cancelled requests are dropped; slow `implements` answers (>150 ms) are filled in when they arrive.
- **Module gopls for other repositories**: `GOGC=50`, no telemetry sidecar, GC when idle; stops 1 minute after the module's last tab closes or after 5 idle minutes; at most 2.

### Settings

| Setting | Default | Description |
| --- | --- | --- |
| `goCodeInsight.enable` | `true` | Master switch |
| `goCodeInsight.dependencies.enable` | `true` | Lenses in dependency files |
| `goCodeInsight.dependencies.index` | `true` | Persistent index for module-cache dependencies |
| `goCodeInsight.dependencies.prebuild` | `sameOrg` | Modules to index ahead of time: `sameOrg` / `all` / `off` |
| `goCodeInsight.references.enable` | `true` | `N refs` |
| `goCodeInsight.references.fields` | `true` | `N refs` on struct fields |
| `goCodeInsight.implementations.enable` | `true` | Implementation counts on interfaces |
| `goCodeInsight.implements.enable` | `true` | `implements …` on types and methods |
| `goCodeInsight.implements.maxNames` | `3` | Interface names shown inline |
| `goCodeInsight.implements.hideUnexportedForeign` | `true` | Hide unexported interfaces of other packages |
| `goCodeInsight.implements.exclude` | `[]` | Interfaces to hide, e.g. `["fmt.Stringer"]` |
| `goCodeInsight.methods.enable` | `true` | `N methods` on types |
| `goCodeInsight.packageImports.enable` | `true` | `N imports` on the package clause |
| `goCodeInsight.inlineValues.enable` | `true` | Debugger inline values |
| `goCodeInsight.inlineValues.maxLength` | `50` | Maximum inline value length |
| `goCodeInsight.outsideWorkspace.moduleIndex` | `true` | Module gopls for files from other repositories |
| `goCodeInsight.outsideWorkspace.idleMinutes` | `5` | Idle minutes before a module gopls stops |
| `goCodeInsight.outsideWorkspace.maxServers` | `2` | Maximum module gopls processes |
| `goCodeInsight.goplsPath` | `""` | gopls for module gopls processes (auto-detected) |
| `goCodeInsight.maxConcurrentRequests` | `8` | Concurrent gopls requests |
| `goCodeInsight.refreshDelay` | `800` | Cross-file refresh debounce (ms) |

Setting descriptions and command names are shown in Chinese when VS Code's display language is Chinese.

### Development

```bash
npm install
npm run compile        # build to out/
npm run package        # build the .vsix (includes the indexer source)
```

Press F5 (Run Extension) in VS Code to debug the extension.

---

## 中文

### 功能

#### 1. CodeLens（工作区与依赖包）

```go
no imports                                              ← package 子句：被多少文件 import
package t

1 ref | 3 implementations                               ← 接口：实现数
type Shape interface {
    0 refs | 3 implementations                          ← 接口方法：实现数
    Area() float64
}

4 refs | implements Shape, fmt.Stringer, io.Reader | 3 methods
type Sq struct {
    2 refs                                              ← 字段引用数
    side float64
}

0 refs | implements io.Reader.Read                      ← 方法实现了哪个接口的哪个方法
func (q *Sq) Read(p []byte) (int, error) { ... }
```

| 位置 | CodeLens | 点击 |
| --- | --- | --- |
| package 子句 | `N imports`（导入该包的文件数） | Peek 列表 |
| 接口 / 接口方法 | `N implementations`（只算具体类型） | 1 个直接跳转，多个 Peek |
| 结构体 / 自定义类型 | `implements A, pkg.B, …`（含标准库、依赖包接口）、`N methods` | 同上 |
| 方法 | `implements io.Reader.Read` | 跳到接口方法 |
| 类型 / 函数 / 方法 / 字段 | `N refs` | Peek 引用列表 |

不实现任何接口的类型/方法不显示 implements；嵌入字段与单行 struct 的字段不显示字段 CodeLens。

**依赖包中的 CodeLens**（`goCodeInsight.dependencies.enable`）：
- **模块缓存中的依赖**（`…/pkg/mod/x@v1.2.3`）：内置索引器（`indexer/main.go`，对模块做一次 `go/types` 类型检查）为每个模块版本建立一次交叉引用索引，存于 `~/Library/Caches/go-code-insight`（Linux `~/.cache`，Windows `%LOCALAPPDATA%`），所有窗口共享，之后直接读盘，不启动语言服务器。结果与工作区内的引用合并，计数与 gopls 一致（在 97 个包的模块上实测：引用 549/549、实现 71/71 个声明相同）。
- 启动 10 秒后，在后台为工作区依赖中**同组织**的模块预建索引（`goCodeInsight.dependencies.prebuild`：`sameOrg` / `all` / `off`），每个模块版本只建一次。
- **其它仓库**（可修改的目录）：按需为该模块启动一个 gopls（见下文资源限制）。
- 标准库：只统计当前工作区，显示为 `N refs (in <工作区>)`。

#### 2. 调试内联值

通过 Go 扩展（dlv）调试并停下时，在当前函数中、停止行及之前，每一行行尾显示该行用到的变量和参数的值 `name = value`：

```go
func describe(prefix string, n int) string {      prefix = "p", n = 7
	total := 0                                     total = 1
	parts := []string{prefix}                      parts = []string len: 1, cap: 1, ["p"], prefix = "p"
	for i, w := range []string{"a", "bb"} {        i = 0, w = "a"
		total += i + len(w)                         total = 1, i = 0, w = "a"
		parts = append(parts, w)  ◀ 停在这里          parts = []string len: 1, cap: 1, ["p"], w = "a"
```

- 作用域按 Go 规则处理：`if/for/switch` 头部变量、只在循环内有效的 `for range` 变量、闭包参数与捕获变量、变量遮蔽；注释、字符串、复合字面量的键、`x.field` 选择子不会被误标。
- 值来自调试器：每次停止只发 2 个 DAP 请求（`scopes` + `variables`），同一停止点内缓存。
- 过于复杂的值不显示：结构体 / 切片 / map 超过 `goCodeInsight.inlineValues.maxLength`（默认 50）时隐藏；过长的标量截断。
- 需要 VS Code 设置 `debug.inlineValues` 为 `auto`（默认）或 `on`。

### 依赖

- 官方 Go 扩展（`golang.go`），启用 gopls（默认）。工作区查询复用它的 gopls。
- 依赖索引需要本机 Go 工具链（首次使用时编译索引器约 1 秒，缓存在上述目录）。

### 刷新

- 当前文件编辑后自动重算；其它可见 Go 编辑器在停止输入 `refreshDelay` 毫秒后刷新。
- 只改注释、空行、格式时不重新查询（token 级哈希判断），只平移缓存的位置。
- 磁盘上的 `*.go`、`go.mod`、`go.work` 变化同样触发刷新。命令：`Go Code Insight: 开关 CodeLens` / `刷新 CodeLens`。

### 性能与资源

与 Tooltitude for Go 的实测对比（同一台机器，独立 VS Code 实例，一个多模块业务工作区，打开模块缓存中某个依赖模块的文件，一个共 67 处引用的函数）：

| | Tooltitude | Go Code Insight |
| --- | --- | --- |
| 打开依赖文件到出现计数 | 0.1–0.7 s | 0.2–0.3 s（先显示模块内的 `65 refs …`） |
| 计数完全准确（含工作区引用） | 0.1–0.7 s | gopls 已运行：0.8 s；gopls 刚启动：1.2–1.4 s |
| 常驻额外进程 | 每个窗口 1 个，约 300 MB，启动时 3.3–5.2 s CPU | 无（索引在磁盘，所有窗口共享） |
| 建索引 | 每个窗口每次启动都重建 | 每个模块版本只建一次：97 个包的模块约 0.5–1 s、峰值约 80 MB，建完进程退出 |
| 调试内联值 | 付费功能，依赖常驻进程 | 每次停止 1–7 ms（2 个 DAP 请求），无额外进程 |

工作区对依赖符号的引用由 Go 扩展的 gopls 计算，打开依赖文件后它需要先加载该包，所以精确计数比 Tooltitude 略晚；Tooltitude 的这部分来自它常驻内存的索引。

- **不常驻额外进程**：工作区查询使用 Go 扩展的 gopls；依赖包使用磁盘索引（索引器建完即退出）；调试内联值在扩展进程内计算。
- **本地解析代替 gopls 请求**：符号提取（在 167 个文件上与 gopls documentSymbol 结果一致，约 0.16 ms/文件）、方法计数、注释编辑判断、调试作用域分析都在本地完成。
- **按需与限流**：引用数 / 实现数只为可见区域的 CodeLens 查询；implements 每个类型 1 次请求、只计算视口 ±100 行；并发上限 `maxConcurrentRequests`；被取消的请求直接丢弃；implements 超过 150 ms 时先显示其余 CodeLens，结果到达后补上。
- **其它仓库的模块 gopls**：`GOGC=50`、不启动 telemetry 子进程、空闲时 GC；关闭该模块最后一个标签页 1 分钟后或 5 分钟无查询后退出；最多 2 个。

### 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `goCodeInsight.enable` | `true` | 总开关 |
| `goCodeInsight.dependencies.enable` | `true` | 在依赖包文件中显示 CodeLens |
| `goCodeInsight.dependencies.index` | `true` | 模块缓存依赖使用持久索引 |
| `goCodeInsight.dependencies.prebuild` | `sameOrg` | 预建哪些依赖模块的索引：`sameOrg` / `all` / `off` |
| `goCodeInsight.references.enable` | `true` | `N refs` |
| `goCodeInsight.references.fields` | `true` | 结构体字段的 `N refs` |
| `goCodeInsight.implementations.enable` | `true` | 接口上的实现数 |
| `goCodeInsight.implements.enable` | `true` | 类型/方法上的 `implements …` |
| `goCodeInsight.implements.maxNames` | `3` | 行内最多显示的接口名 |
| `goCodeInsight.implements.hideUnexportedForeign` | `true` | 隐藏其它包的未导出接口 |
| `goCodeInsight.implements.exclude` | `[]` | 不显示的接口，如 `["fmt.Stringer"]` |
| `goCodeInsight.methods.enable` | `true` | 类型上的 `N methods` |
| `goCodeInsight.packageImports.enable` | `true` | package 子句上的 `N imports` |
| `goCodeInsight.inlineValues.enable` | `true` | 调试内联值 |
| `goCodeInsight.inlineValues.maxLength` | `50` | 内联值最大长度 |
| `goCodeInsight.outsideWorkspace.moduleIndex` | `true` | 其它仓库的文件按需启动模块 gopls |
| `goCodeInsight.outsideWorkspace.idleMinutes` | `5` | 模块 gopls 空闲退出时间（分钟） |
| `goCodeInsight.outsideWorkspace.maxServers` | `2` | 模块 gopls 进程上限 |
| `goCodeInsight.goplsPath` | `""` | 模块 gopls 使用的可执行文件（默认自动查找） |
| `goCodeInsight.maxConcurrentRequests` | `8` | gopls 最大并发请求数 |
| `goCodeInsight.refreshDelay` | `800` | 跨文件刷新防抖（毫秒） |

VS Code 显示语言为中文时，设置说明和命令名称会显示中文。

### 开发

```bash
npm install
npm run compile        # 编译到 out/
npm run package        # 生成 .vsix（包含索引器源码）
```

在 VS Code 中按 F5（Run Extension）调试本扩展。

---

License / 许可：[Apache-2.0](LICENSE)
