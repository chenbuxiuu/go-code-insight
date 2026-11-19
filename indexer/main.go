// Command indexer builds a cross-reference index of one Go module (typically an
// immutable module-cache directory) so that lenses in dependency files can be
// served from disk without running a language server.
//
// Usage: indexer <moduleRoot> <outDir>
//
// The module's packages are type-checked from source with go/types; every other
// package is imported from compiler export data produced by `go list -export`
// (served from the Go build cache). Standard library only.
//
// Output (all positions 0-based, columns in UTF-16 code units like LSP):
//
//	outDir/meta.json                 {"version":1,"root":...,"packages":N}
//	outDir/files/<rel path>.json     {"f":[abs file paths], "d":{"line:col":{"r":[],"i":[],"t":[]}}}
//
// where each location is [fileIndex, line, col, endCol]; "r" = references,
// "i" = implementations (interfaces / interface methods), "t" = interfaces a
// concrete type implements. The entry at the package name lists the import specs.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/importer"
	"go/parser"
	"go/token"
	"go/types"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

const version = 1

type listPkg struct {
	ImportPath string
	ForTest    string
	Dir        string
	Name       string
	GoFiles    []string
	CgoFiles   []string
	Imports    []string
	ImportMap  map[string]string
	Export     string
	DepOnly    bool
}

type loc [4]int // file, line, col, endCol

type entry struct {
	R []loc `json:"r,omitempty"`
	I []loc `json:"i,omitempty"`
	T []loc `json:"t,omitempty"`
}

type shard struct {
	files  []string
	fileID map[string]int
	F      []string          `json:"f"`
	D      map[string]*entry `json:"d"`
}

func (s *shard) id(file string) int {
	if i, ok := s.fileID[file]; ok {
		return i
	}
	s.fileID[file] = len(s.F)
	s.F = append(s.F, file)
	return len(s.F) - 1
}

type indexer struct {
	root    string
	fset    *token.FileSet
	pkgs    map[string]*listPkg
	exports map[string]string
	gc      types.Importer
	checked map[string]*types.Package
	infos   map[*types.Package]*types.Info
	files   map[*types.Package][]*ast.File
	srcs    map[string][]byte // file -> content (module files, and dependency files read for positions)
	shards  map[string]*shard // module file -> shard
	uses    map[string][]token.Position // declaration key -> use sites (byte positions)
	idents  map[string]int              // use site key -> identifier length
	related map[string]map[string]bool  // method key -> methods related by interface satisfaction
	decls   map[string]types.Object     // declaration key -> object
	byName  map[string]*token.File
}

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "usage: indexer <moduleRoot> <outDir>")
		os.Exit(2)
	}
	root, _ := filepath.Abs(os.Args[1])
	if err := run(root, os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(root, out string) error {
	ix := &indexer{
		root:    root,
		fset:    token.NewFileSet(),
		pkgs:    map[string]*listPkg{},
		exports: map[string]string{},
		checked: map[string]*types.Package{},
		infos:   map[*types.Package]*types.Info{},
		files:   map[*types.Package][]*ast.File{},
		srcs:    map[string][]byte{},
		shards:  map[string]*shard{},
		uses:    map[string][]token.Position{},
		idents:  map[string]int{},
		related: map[string]map[string]bool{},
		decls:   map[string]types.Object{},
	}
	if err := ix.list(); err != nil {
		return err
	}
	ix.gc = importer.ForCompiler(ix.fset, "gc", func(path string) (io.ReadCloser, error) {
		f, ok := ix.exports[path]
		if !ok {
			return nil, fmt.Errorf("no export data for %s", path)
		}
		return os.Open(f)
	})
	paths := make([]string, 0, len(ix.pkgs))
	for p := range ix.pkgs {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		ix.check(p)
	}
	ix.references()
	ix.implementations()
	ix.flushReferences()
	ix.imports()
	return ix.write(out)
}

func (ix *indexer) list() error {
	cmd := exec.Command("go", "list", "-e", "-test", "-export", "-deps",
		"-json=ImportPath,ForTest,Dir,Name,GoFiles,CgoFiles,Imports,ImportMap,Export,DepOnly", "./...")
	cmd.Dir = ix.root
	cmd.Stderr = os.Stderr
	outp, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	dec := json.NewDecoder(outp)
	for {
		var p listPkg
		if err := dec.Decode(&p); err == io.EOF {
			break
		} else if err != nil {
			return err
		}
		if p.Export != "" {
			ix.exports[p.ImportPath] = p.Export
		}
		inRoot := strings.HasPrefix(p.Dir+string(filepath.Separator), ix.root+string(filepath.Separator))
		if p.DepOnly || !inRoot || strings.HasSuffix(p.ImportPath, ".test") {
			continue
		}
		// Source-check normal packages and the test variants that carry test files
		// ("p [p.test]", "p_test [p.test]"); other recompiled variants come from export data.
		if p.ForTest != "" && !hasTestFiles(p.GoFiles) {
			continue
		}
		pp := p
		ix.pkgs[p.ImportPath] = &pp
	}
	return cmd.Wait()
}

func hasTestFiles(names []string) bool {
	for _, n := range names {
		if strings.HasSuffix(n, "_test.go") {
			return true
		}
	}
	return false
}

func isTestFile(file string) bool { return strings.HasSuffix(file, "_test.go") }

type importerFunc func(path string) (*types.Package, error)

func (f importerFunc) Import(path string) (*types.Package, error) { return f(path) }

// check type-checks a module package from source (after its module imports).
func (ix *indexer) check(path string) *types.Package {
	if pkg, ok := ix.checked[path]; ok {
		return pkg
	}
	p := ix.pkgs[path]
	ix.checked[path] = nil // cycle guard
	var files []*ast.File
	for _, name := range append(append([]string{}, p.GoFiles...), p.CgoFiles...) {
		file := filepath.Join(p.Dir, name)
		src, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		f, _ := parser.ParseFile(ix.fset, file, src, parser.SkipObjectResolution)
		if f != nil {
			ix.srcs[file] = src
			files = append(files, f)
		}
	}
	conf := types.Config{
		Importer: importerFunc(func(ipath string) (*types.Package, error) {
			if m, ok := p.ImportMap[ipath]; ok {
				ipath = m
			}
			if ipath == "unsafe" {
				return types.Unsafe, nil
			}
			if _, ok := ix.pkgs[ipath]; ok {
				if pkg := ix.check(ipath); pkg != nil {
					return pkg, nil
				}
			}
			return ix.gc.Import(ipath)
		}),
		Error:       func(error) {}, // keep going; partial info is still useful
		FakeImportC: true,
	}
	info := &types.Info{Defs: map[*ast.Ident]types.Object{}, Uses: map[*ast.Ident]types.Object{}}
	pkg, _ := conf.Check(path, ix.fset, files, info)
	ix.checked[path] = pkg
	if pkg != nil {
		ix.infos[pkg] = info
		ix.files[pkg] = files
	}
	return pkg
}

// ---------------------------------------------------------------- positions

func (ix *indexer) source(file string) []byte {
	if src, ok := ix.srcs[file]; ok {
		return src
	}
	src, _ := os.ReadFile(file)
	ix.srcs[file] = src
	return src
}

// utf16Col converts a 1-based byte column on a 1-based line into a 0-based UTF-16 column.
func (ix *indexer) position(pos token.Pos, nameLen int) (file string, line, col, endCol int, ok bool) {
	p := ix.fset.Position(pos)
	if !p.IsValid() || p.Filename == "" {
		return "", 0, 0, 0, false
	}
	src := ix.source(p.Filename)
	// Find the start of the line.
	start := 0
	for l := 1; l < p.Line && start < len(src); l++ {
		i := indexByte(src[start:], '\n')
		if i < 0 {
			break
		}
		start += i + 1
	}
	prefix := src[start:min(start+p.Column-1, len(src))]
	col = utf16Len(prefix)
	name := src[min(start+p.Column-1, len(src)):min(start+p.Column-1+nameLen, len(src))]
	return p.Filename, p.Line - 1, col, col + utf16Len(name), true
}

func indexByte(b []byte, c byte) int {
	for i, x := range b {
		if x == c {
			return i
		}
	}
	return -1
}

func utf16Len(b []byte) int {
	n := 0
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		n += len(utf16.Encode([]rune{r}))
		b = b[size:]
	}
	return n
}

func (ix *indexer) inModule(file string) bool {
	return strings.HasPrefix(file, ix.root+string(filepath.Separator))
}

// entryFor returns the shard entry for the declaration of obj (nil if not a module declaration).
func (ix *indexer) entryFor(obj types.Object) *entry {
	file, line, col, _, ok := ix.position(obj.Pos(), len(obj.Name()))
	if !ok || !ix.inModule(file) {
		return nil
	}
	s := ix.shardFor(file)
	key := fmt.Sprintf("%d:%d", line, col)
	e := s.D[key]
	if e == nil {
		e = &entry{}
		s.D[key] = e
	}
	return e
}

func (ix *indexer) shardFor(file string) *shard {
	s := ix.shards[file]
	if s == nil {
		s = &shard{fileID: map[string]int{}, D: map[string]*entry{}}
		ix.shards[file] = s
	}
	return s
}

func (ix *indexer) locIn(s *shard, pos token.Pos, nameLen int) (loc, bool) {
	file, line, col, end, ok := ix.position(pos, nameLen)
	if !ok {
		return loc{}, false
	}
	return loc{s.id(file), line, col, end}, true
}

// ---------------------------------------------------------------- relations

// modulePackages returns the type-checked normal (non-test) packages of the module.
func (ix *indexer) modulePackages() []*types.Package {
	var out []*types.Package
	for path, pkg := range ix.checked {
		if pkg != nil && ix.pkgs[path].ForTest == "" {
			out = append(out, pkg)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path() < out[j].Path() })
	return out
}

// interesting: package-level funcs/types, methods, struct fields, interface methods.
func interesting(obj types.Object) bool {
	switch o := obj.(type) {
	case *types.Func:
		return true
	case *types.TypeName:
		return o.Parent() != nil && o.Parent() == o.Pkg().Scope()
	case *types.Var:
		return o.IsField()
	}
	return false
}

// key identifies a declaration by position, so that objects of the same declaration
// coming from different type-checks (test variants, export data) coincide.
func (ix *indexer) key(obj types.Object) (string, bool) {
	p := ix.fset.Position(obj.Pos())
	if !p.IsValid() || !ix.inModule(p.Filename) {
		return "", false
	}
	return fmt.Sprintf("%s:%d:%d", p.Filename, p.Line, p.Column), true
}

func (ix *indexer) references() {
	for path, pkg := range ix.checked {
		if pkg == nil {
			continue
		}
		testVariant := ix.pkgs[path].ForTest != ""
		info := ix.infos[pkg]
		for id, obj := range info.Defs {
			if obj == nil || !interesting(obj) || obj.Pos() != id.Pos() {
				continue
			}
			if testVariant && !isTestFile(ix.fset.Position(id.Pos()).Filename) {
				continue
			}
			if k, ok := ix.key(obj); ok {
				ix.decls[k] = obj
			}
		}
		for id, obj := range info.Uses {
			if obj == nil || obj.Pkg() == nil || !interesting(obj) {
				continue
			}
			at := ix.fset.Position(id.Pos())
			if testVariant && !isTestFile(at.Filename) {
				continue // counted by the normal package already
			}
			if f, ok := obj.(*types.Func); ok {
				obj = f.Origin()
			} else if v, ok := obj.(*types.Var); ok {
				obj = v.Origin()
			}
			k, ok := ix.key(obj)
			if !ok {
				continue
			}
			if _, known := ix.decls[k]; !known {
				ix.decls[k] = obj
			}
			ix.uses[k] = append(ix.uses[k], at)
			ix.idents[fmt.Sprintf("%s:%d:%d", at.Filename, at.Line, at.Column)] = len(id.Name)
		}
	}
}

// relate records that methods a and b correspond (gopls includes references to
// methods related by interface satisfaction).
func (ix *indexer) relate(a, b types.Object) {
	ka, ok1 := ix.key(a)
	kb, ok2 := ix.key(b)
	if !ok1 || !ok2 || ka == kb {
		return
	}
	for _, p := range [][2]string{{ka, kb}, {kb, ka}} {
		if ix.related[p[0]] == nil {
			ix.related[p[0]] = map[string]bool{}
		}
		ix.related[p[0]][p[1]] = true
	}
}

// flushReferences writes every declaration with its (expanded) references.
func (ix *indexer) flushReferences() {
	for k, obj := range ix.decls {
		e := ix.entryFor(obj)
		if e == nil {
			continue
		}
		declFile, _, _, _, _ := ix.position(obj.Pos(), 0)
		s := ix.shardFor(declFile)
		seen := map[string]bool{}
		add := func(list []token.Position) {
			for _, at := range list {
				ak := fmt.Sprintf("%s:%d:%d", at.Filename, at.Line, at.Column)
				if seen[ak] {
					continue
				}
				seen[ak] = true
				if l, ok := ix.locAt(s, at, ix.idents[ak]); ok {
					e.R = append(e.R, l)
				}
			}
		}
		add(ix.uses[k])
		for rk := range ix.related[k] {
			add(ix.uses[rk])
		}
	}
}

func (ix *indexer) locAt(s *shard, at token.Position, nameLen int) (loc, bool) {
	f := ix.tokenFile(at.Filename)
	if f == nil || at.Line > f.LineCount() {
		return loc{}, false
	}
	return ix.locIn(s, f.LineStart(at.Line)+token.Pos(at.Column-1), nameLen)
}

// tokenFile returns the parsed file with the given name (module files only).
func (ix *indexer) tokenFile(name string) *token.File {
	if ix.byName == nil {
		ix.byName = map[string]*token.File{}
		ix.fset.Iterate(func(f *token.File) bool {
			ix.byName[f.Name()] = f
			return true
		})
	}
	return ix.byName[name]
}

// allPackages returns the module packages plus everything they import, transitively.
func (ix *indexer) allPackages() []*types.Package {
	seen := map[*types.Package]bool{}
	var out []*types.Package
	var walk func(p *types.Package)
	walk = func(p *types.Package) {
		if p == nil || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
		for _, q := range p.Imports() {
			walk(q)
		}
	}
	for _, p := range ix.modulePackages() {
		walk(p)
	}
	// Like gopls, consider every package of the dependency graph, not only those
	// reachable through export data.
	paths := make([]string, 0, len(ix.exports))
	for path := range ix.exports {
		if !strings.Contains(path, " [") && !strings.HasSuffix(path, ".test") {
			paths = append(paths, path)
		}
	}
	sort.Strings(paths)
	for _, path := range paths {
		if _, isModule := ix.pkgs[path]; isModule {
			continue
		}
		if pkg, err := ix.gc.Import(path); err == nil {
			walk(pkg)
		}
	}
	return out
}

type named struct {
	obj   *types.TypeName
	typ   types.Type
	names map[string]bool
}

func methodNames(t types.Type) map[string]bool {
	out := map[string]bool{}
	for _, tt := range []types.Type{t, types.NewPointer(t)} {
		ms := types.NewMethodSet(tt)
		for i := 0; i < ms.Len(); i++ {
			out[ms.At(i).Obj().Name()] = true
		}
	}
	return out
}

func (ix *indexer) implementations() {
	var ifaces, concretes []named
	moduleSet := map[*types.Package]bool{}
	for _, p := range ix.modulePackages() {
		moduleSet[p] = true
	}
	for _, pkg := range ix.allPackages() {
		scope := pkg.Scope()
		for _, name := range scope.Names() {
			tn, ok := scope.Lookup(name).(*types.TypeName)
			if !ok || tn.IsAlias() {
				continue
			}
			t := tn.Type()
			if _, isNamed := t.(*types.Named); isNamed && t.(*types.Named).TypeParams().Len() > 0 {
				continue // generic types: skip (instantiation needed)
			}
			if it, ok := t.Underlying().(*types.Interface); ok {
				if it.NumMethods() > 0 {
					ifaces = append(ifaces, named{obj: tn, typ: t, names: methodNames(t)})
				}
			} else if moduleSet[pkg] {
				concretes = append(concretes, named{obj: tn, typ: t, names: methodNames(t)})
			}
		}
	}
	for _, c := range concretes {
		for _, in := range ifaces {
			it := in.typ.Underlying().(*types.Interface)
			if !subset(in.names, c.names) {
				continue
			}
			implements := types.Implements
			if !it.IsMethodSet() {
				implements = types.Satisfies // e.g. interface{ fmt.Stringer; comparable }
			}
			if !implements(c.typ, it) && !implements(types.NewPointer(c.typ), it) {
				continue
			}
			// concrete type -> implemented interface
			if e := ix.entryFor(c.obj); e != nil {
				declFile, _, _, _, _ := ix.position(c.obj.Pos(), 0)
				if l, ok := ix.locIn(ix.shardFor(declFile), in.obj.Pos(), len(in.obj.Name())); ok {
					e.T = append(e.T, l)
				}
			}
			// interface -> implementation (only for interfaces declared in the module)
			if e := ix.entryFor(in.obj); e != nil {
				for i := 0; i < it.NumMethods(); i++ {
					m := it.Method(i)
					if sel := types.NewMethodSet(types.NewPointer(c.typ)).Lookup(m.Pkg(), m.Name()); sel != nil {
						ix.relate(m, sel.Obj())
					}
				}
				declFile, _, _, _, _ := ix.position(in.obj.Pos(), 0)
				if l, ok := ix.locIn(ix.shardFor(declFile), c.obj.Pos(), len(c.obj.Name())); ok {
					e.I = append(e.I, l)
				}
				// interface method -> concrete method
				for i := 0; i < it.NumExplicitMethods(); i++ {
					m := it.ExplicitMethod(i)
					sel := types.NewMethodSet(types.NewPointer(c.typ)).Lookup(m.Pkg(), m.Name())
					if sel == nil {
						continue
					}
					if me := ix.entryFor(m); me != nil {
						mFile, _, _, _, _ := ix.position(m.Pos(), 0)
						if l, ok := ix.locIn(ix.shardFor(mFile), sel.Obj().Pos(), len(m.Name())); ok {
							me.I = append(me.I, l)
						}
					}
				}
			}
		}
	}
}

func subset(a, b map[string]bool) bool {
	for k := range a {
		if !b[k] {
			return false
		}
	}
	return true
}

// imports records, for every module package, the import specs that import it.
func (ix *indexer) imports() {
	importers := map[string][]*ast.ImportSpec{}
	for _, pkg := range ix.modulePackages() {
		p := ix.pkgs[pkg.Path()]
		for _, f := range ix.files[pkg] {
			for _, spec := range f.Imports {
				path := strings.Trim(spec.Path.Value, "\"`")
				if m, ok := p.ImportMap[path]; ok {
					path = m
				}
				importers[path] = append(importers[path], spec)
			}
		}
	}
	for _, pkg := range ix.modulePackages() {
		specs := importers[pkg.Path()]
		for _, f := range ix.files[pkg] {
			file := ix.fset.Position(f.Package).Filename
			s := ix.shardFor(file)
			// References on the package name are the import specs (like gopls).
			_, line, col, _, ok := ix.position(f.Name.Pos(), len(f.Name.Name))
			if !ok {
				continue
			}
			e := &entry{}
			for _, spec := range specs {
				if l, ok := ix.locIn(s, spec.Path.Pos(), len(spec.Path.Value)); ok {
					e.R = append(e.R, l)
				}
			}
			s.D[fmt.Sprintf("%d:%d", line, col)] = e
		}
	}
}

// ---------------------------------------------------------------- output

func (ix *indexer) write(out string) error {
	tmp := out + ".tmp"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(filepath.Join(tmp, "files"), 0o755); err != nil {
		return err
	}
	for file, s := range ix.shards {
		rel, err := filepath.Rel(ix.root, file)
		if err != nil {
			continue
		}
		name := strings.ReplaceAll(filepath.ToSlash(rel), "/", "__") + ".json"
		b, err := json.Marshal(s)
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(tmp, "files", name), b, 0o644); err != nil {
			return err
		}
	}
	meta, _ := json.Marshal(map[string]any{"version": version, "root": ix.root, "packages": len(ix.infos)})
	if err := os.WriteFile(filepath.Join(tmp, "meta.json"), meta, 0o644); err != nil {
		return err
	}
	_ = os.RemoveAll(out)
	return os.Rename(tmp, out)
}
