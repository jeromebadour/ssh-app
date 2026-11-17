package hostile

// A file subsystem for the lab's stand-in box: enough of SFTP version 3 for the app's own file browser to be
// driven against it, backed by a real folder on disk. It is a lab tool and is in no program that ships.
//
// It is deliberately small and plain: the point is to give the window something real to list, open and move,
// not to be a complete server. What a real server does is proven separately, against OpenSSH 8.9 and 10.5.

import (
	"encoding/binary"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	fxpInit     = 1
	fxpVersion  = 2
	fxpOpen     = 3
	fxpClose    = 4
	fxpRead     = 5
	fxpWrite    = 6
	fxpLstat    = 7
	fxpFsetstat = 10
	fxpOpendir  = 11
	fxpReaddir  = 12
	fxpRemove   = 13
	fxpMkdir    = 14
	fxpRmdir    = 15
	fxpRealpath = 16
	fxpStat     = 17
	fxpRename   = 18
	fxpReadlink = 19

	fxpStatus        = 101
	fxpHandle        = 102
	fxpData          = 103
	fxpName          = 104
	fxpAttrs         = 105
	fxpExtended      = 200
	fxpExtendedReply = 201
)

const (
	fxOK = iota
	fxEOF
	fxNoSuchFile
	fxPermissionDenied
	fxFailure
)

// pace is how long the lab box waits before answering each page of a listing, and each piece of a file read.
// It is a lab knob: it makes a
// listing take a known amount of time without needing a folder with a hundred thousand things in it, so what
// the window does with a listing still arriving can be driven and proven.
var pace atomic.Int64

// pages counts every page of a listing this box has been asked for, so a test can see whether a listing that
// was left behind is still being read.
var pages atomic.Int64

// Pages is that count.
func Pages() int64 { return pages.Load() }

// Pace sets that wait, in milliseconds. Zero is no wait at all.
func Pace(ms int64) { pace.Store(ms) }

// fsidOf gives each /mnt/<name> its own filesystem id, and everything else the box's own.
func fsidOf(p string) uint64 {
	clean := path.Clean("/" + strings.TrimPrefix(p, "/"))
	if !strings.HasPrefix(clean+"/", "/mnt/") {
		return 1
	}
	bits := strings.Split(strings.TrimPrefix(clean, "/mnt/"), "/")
	if bits[0] == "" {
		return 1
	}
	var n uint64 = 14695981039346656037
	for _, c := range []byte("/mnt/" + bits[0]) {
		n = (n ^ uint64(c)) * 1099511628211
	}
	return n
}

// pretend is one file the box lies about the size of, for the lab.
type pretendSize struct {
	name string
	size uint64
}

var pretend atomic.Pointer[pretendSize]

// PretendSize makes the box say a file of this name is this big, whatever it really is. An empty name puts
// every file back to its real size.
// failReadsAt is the offset past which this box answers no read, for the lab. Zero means it answers all.
var failReadsAt atomic.Int64

// FailReadsAt makes the box stop answering reads from this offset on. Zero puts it back to answering.
func FailReadsAt(at int64) { failReadsAt.Store(at) }

func PretendSize(name string, size uint64) {
	if name == "" {
		pretend.Store(nil)
		return
	}
	pretend.Store(&pretendSize{name: name, size: size})
}

type fileServer struct {
	root string // every path is taken as being under this folder

	mu      sync.Mutex
	dirs    map[string][]os.DirEntry // an open folder and what is left of it
	files   map[string]*os.File
	nextKey int
}

// serveFiles answers the file protocol on one channel, under this folder.
func serveFiles(ch io.ReadWriteCloser, root string) {
	s := &fileServer{root: root, dirs: map[string][]os.DirEntry{}, files: map[string]*os.File{}}
	defer func() {
		s.mu.Lock()
		for _, f := range s.files {
			_ = f.Close()
		}
		s.mu.Unlock()
		_ = ch.Close()
	}()
	for {
		kind, body, err := readPacket(ch)
		if err != nil {
			return
		}
		if kind == fxpInit {
			var w pkt
			w.u32(3)
			w.str("posix-rename@openssh.com")
			w.str("1")
			w.str("statvfs@openssh.com")
			w.str("2")
			if writePacket(ch, fxpVersion, w.b) != nil {
				return
			}
			continue
		}
		r := &take{b: body}
		id := r.u32()
		kindOut, out := s.answer(kind, id, r)
		var w pkt
		w.u32(id)
		w.b = append(w.b, out...)
		if writePacket(ch, kindOut, w.b) != nil {
			return
		}
	}
}

// under keeps every path inside the lab folder, so a test cannot reach the machine's own files by mistake.
// asBox turns a path on the machine running the lab into the path a box would call it: the box's own files
// are the box's root.
// Both of these cross between two kinds of path and must say which is which. A box's paths have slashes and
// start at its root; the machine running the lab has its own, and on Windows they have backslashes and a
// drive letter. Mixing the two reads "C:\\lab\\srv\\app" as a box path and makes nonsense of everything
// judged on it, which is how every file test of the engine failed on Windows while passing on Linux.
func (s *fileServer) asBox(p string) string {
	here := filepath.ToSlash(p)
	root := filepath.ToSlash(s.root)
	cut := strings.TrimPrefix(here, root)
	if cut == "" || cut == "/" {
		return "/"
	}
	return path.Clean("/" + strings.TrimPrefix(cut, "/"))
}

func (s *fileServer) under(raw []byte) string {
	asked := filepath.ToSlash(string(raw))
	clean := path.Clean("/" + strings.TrimPrefix(asked, filepath.ToSlash(s.root)))
	return filepath.Join(s.root, filepath.FromSlash(clean))
}

func (s *fileServer) answer(kind byte, id uint32, r *take) (byte, []byte) {
	switch kind {
	case fxpRealpath:
		// As a real box answers: the path from the top of the box, not where the test happens to keep it. The
		// app judges what it may delete on what comes back from here, so a lab that answered with its own
		// temporary folder would let every one of those judgements pass without being tried.
		here := s.under(r.str())
		// A real box follows links here, and what the app may delete is judged on what comes back: a lab that
		// did not follow them would let a link into the system through as an innocent name in a home folder.
		if real, err := filepath.EvalSymlinks(here); err == nil {
			here = real
		}
		p := s.asBox(here)
		var w pkt
		w.u32(1)
		w.str(p)
		w.str(p)
		w.b = append(w.b, 0, 0, 0, 0)
		return fxpName, w.b
	case fxpStat, fxpLstat:
		p := s.under(r.str())
		var fi os.FileInfo
		var err error
		if kind == fxpStat {
			fi, err = os.Stat(p)
		} else {
			fi, err = os.Lstat(p)
		}
		if err != nil {
			return fxpStatus, status(codeOf(err), err.Error())
		}
		var w pkt
		w.attrs(fi)
		return fxpAttrs, w.b
	case fxpOpendir:
		p := s.under(r.str())
		list, err := os.ReadDir(p)
		if err != nil {
			return fxpStatus, status(codeOf(err), err.Error())
		}
		s.mu.Lock()
		s.nextKey++
		key := "d" + itoa(s.nextKey)
		s.dirs[key] = list
		s.mu.Unlock()
		var w pkt
		w.str(key)
		return fxpHandle, w.b
	case fxpReaddir:
		pages.Add(1)
		if ms := pace.Load(); ms > 0 {
			time.Sleep(time.Duration(ms) * time.Millisecond)
		}
		key := string(r.str())
		s.mu.Lock()
		left, there := s.dirs[key]
		if there {
			if len(left) > 50 {
				s.dirs[key] = left[50:]
				left = left[:50]
			} else {
				s.dirs[key] = nil
			}
		}
		s.mu.Unlock()
		if !there || len(left) == 0 {
			return fxpStatus, status(fxEOF, "")
		}
		var w pkt
		w.u32(uint32(len(left)))
		for _, e := range left {
			fi, err := e.Info()
			w.str(e.Name())
			w.str(e.Name())
			if err != nil {
				w.b = append(w.b, 0, 0, 0, 0)
				continue
			}
			w.attrs(fi)
		}
		return fxpName, w.b
	case fxpOpen:
		p := s.under(r.str())
		flags := r.u32()
		mode := os.FileMode(0o644)
		if has := r.u32(); has&0x4 != 0 {
			mode = os.FileMode(r.u32() & 0o777)
		}
		f, err := os.OpenFile(p, osFlags(flags), mode)
		if err != nil {
			return fxpStatus, status(codeOf(err), err.Error())
		}
		s.mu.Lock()
		s.nextKey++
		key := "f" + itoa(s.nextKey)
		s.files[key] = f
		s.mu.Unlock()
		var w pkt
		w.str(key)
		return fxpHandle, w.b
	case fxpRead:
		// A box that answers slowly, so that a transfer has a middle to be stopped in or watched during.
		if ms := pace.Load(); ms > 0 {
			time.Sleep(time.Duration(ms) * time.Millisecond)
		}
		key := string(r.str())
		at := r.u64()
		// A box that stops answering part way through a file, which is what a link going down looks like from
		// here: the transfer breaks with bytes already written, which is the case taking one up is for.
		if stop := failReadsAt.Load(); stop > 0 && at >= uint64(stop) {
			return fxpStatus, status(fxFailure, "the box stopped answering")
		}
		want := r.u32()
		s.mu.Lock()
		f := s.files[key]
		s.mu.Unlock()
		if f == nil {
			return fxpStatus, status(fxFailure, "no such handle")
		}
		if want > 1<<16 {
			want = 1 << 16
		}
		buf := make([]byte, want)
		n, err := f.ReadAt(buf, int64(at))
		if n == 0 && err != nil {
			return fxpStatus, status(fxEOF, "")
		}
		var w pkt
		w.bytes(buf[:n])
		return fxpData, w.b
	case fxpWrite:
		// A box that takes bytes slowly, so a transfer has a middle to be watched or stopped in.
		if ms := pace.Load(); ms > 0 {
			time.Sleep(time.Duration(ms) * time.Millisecond)
		}
		key := string(r.str())
		at := r.u64()
		data := r.str()
		s.mu.Lock()
		f := s.files[key]
		s.mu.Unlock()
		if f == nil {
			return fxpStatus, status(fxFailure, "no such handle")
		}
		if _, err := f.WriteAt(data, int64(at)); err != nil {
			return fxpStatus, status(fxFailure, err.Error())
		}
		return fxpStatus, status(fxOK, "")
	case fxpFsetstat:
		// Really done, not merely answered. A lab box that says yes and changes nothing would hide the very
		// bug this is here to catch: a transfer that thinks it put a file's permissions back and did not.
		key := string(r.str())
		flags := r.u32()
		if flags&0x1 != 0 {
			_ = r.u64() // a size we are not asked to set
		}
		if flags&0x2 != 0 {
			_, _ = r.u32(), r.u32() // an owner we are not asked to set
		}
		s.mu.Lock()
		f := s.files[key]
		s.mu.Unlock()
		if f == nil {
			return fxpStatus, status(fxFailure, "no such handle")
		}
		if flags&0x4 != 0 {
			// Through the handle where that works, which is what a box does and what keeps this honest when
			// the name is about to change under it. Windows cannot set permissions through a handle at all,
			// so there it is done by the name the handle was opened with: that is as far as the machine
			// running the lab can go, and it is still really done rather than merely answered.
			mode := os.FileMode(r.u32() & 0o7777)
			err := f.Chmod(mode)
			if err != nil {
				err = os.Chmod(f.Name(), mode)
			}
			if err != nil {
				return fxpStatus, status(codeOf(err), err.Error())
			}
		}
		return fxpStatus, status(fxOK, "")
	case fxpClose:
		key := string(r.str())
		s.mu.Lock()
		if f := s.files[key]; f != nil {
			_ = f.Close()
			delete(s.files, key)
		}
		delete(s.dirs, key)
		s.mu.Unlock()
		return fxpStatus, status(fxOK, "")
	case fxpRemove:
		if err := os.Remove(s.under(r.str())); err != nil {
			return fxpStatus, status(codeOf(err), err.Error())
		}
		return fxpStatus, status(fxOK, "")
	case fxpRmdir:
		if err := os.Remove(s.under(r.str())); err != nil {
			return fxpStatus, status(codeOf(err), err.Error())
		}
		return fxpStatus, status(fxOK, "")
	case fxpMkdir:
		if err := os.Mkdir(s.under(r.str()), 0o755); err != nil {
			return fxpStatus, status(codeOf(err), err.Error())
		}
		return fxpStatus, status(fxOK, "")
	case fxpRename:
		from, to := s.under(r.str()), s.under(r.str())
		if err := os.Rename(from, to); err != nil {
			return fxpStatus, status(codeOf(err), err.Error())
		}
		return fxpStatus, status(fxOK, "")
	case fxpReadlink:
		to, err := os.Readlink(s.under(r.str()))
		if err != nil {
			return fxpStatus, status(codeOf(err), err.Error())
		}
		var w pkt
		w.u32(1)
		w.str(to)
		w.str(to)
		w.b = append(w.b, 0, 0, 0, 0)
		return fxpName, w.b
	case fxpExtended:
		name := string(r.str())
		switch name {
		case "posix-rename@openssh.com":
			from, to := s.under(r.str()), s.under(r.str())
			if err := os.Rename(from, to); err != nil {
				return fxpStatus, status(codeOf(err), err.Error())
			}
			return fxpStatus, status(fxOK, "")
		case "statvfs@openssh.com":
			// Fixed numbers, not this machine's own: the lab box is a stand-in, it runs on Linux and on
			// Windows, and asking the real filesystem would need a different call on each. What the numbers
			// mean is proven against real OpenSSH servers, which do answer from their own disks. These say
			// 40 GB of a 100 GB disk left to this user, with less free to everyone else than to root, which
			// is the case the app must not confuse.
			where := r.str()
			var w pkt
			w.u64(4096)       // f_bsize
			w.u64(4096)       // f_frsize
			w.u64(25_600_000) // f_blocks: 100 GB
			w.u64(12_800_000) // f_bfree: 50 GB, free to root
			w.u64(10_240_000) // f_bavail: 40 GB, free to this user
			w.u64(1_000_000)
			w.u64(900_000)
			w.u64(900_000)
			// f_fsid: a box with more than one disk. Anything under /mnt/<name> is its own filesystem, so the
			// app's own idea of which disk a path is on can be tried against a box that really has two.
			w.u64(fsidOf(string(where)))
			// f_flag: /mnt/stone is a filesystem that takes no writes, so a trash that cannot be made has
			// somewhere real to happen.
			if strings.HasPrefix(path.Clean(string(where))+"/", "/mnt/stone/") {
				w.u64(0x1)
			} else {
				w.u64(0)
			}
			w.u64(255)
			return fxpExtendedReply, w.b
		}
		return fxpStatus, status(fxFailure, "no such extension")
	}
	return fxpStatus, status(fxFailure, "not done by this lab box")
}

func osFlags(f uint32) int {
	out := 0
	switch {
	case f&0x1 != 0 && f&0x2 != 0:
		out = os.O_RDWR
	case f&0x2 != 0:
		out = os.O_WRONLY
	default:
		out = os.O_RDONLY
	}
	if f&0x8 != 0 {
		out |= os.O_CREATE
	}
	if f&0x10 != 0 {
		out |= os.O_TRUNC
	}
	if f&0x20 != 0 {
		out |= os.O_EXCL
	}
	return out
}

func codeOf(err error) uint32 {
	switch {
	case os.IsNotExist(err):
		return fxNoSuchFile
	case os.IsPermission(err):
		return fxPermissionDenied
	}
	return fxFailure
}

func status(code uint32, say string) []byte {
	var w pkt
	w.u32(code)
	w.str(say)
	w.str("")
	return w.b
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}

type pkt struct{ b []byte }

func (w *pkt) u32(v uint32)   { w.b = binary.BigEndian.AppendUint32(w.b, v) }
func (w *pkt) u64(v uint64)   { w.b = binary.BigEndian.AppendUint64(w.b, v) }
func (w *pkt) bytes(v []byte) { w.u32(uint32(len(v))); w.b = append(w.b, v...) }
func (w *pkt) str(v string)   { w.bytes([]byte(v)) }
func (w *pkt) attrs(fi os.FileInfo) {
	w.u32(0x1 | 0x4 | 0x8) // size, permissions, times
	// A box that says a file is bigger than it is. Real boxes do: a file that is being written, a filesystem
	// that reports a size it cannot hold. The app must answer on what the box says before it writes anything.
	size := uint64(fi.Size())
	if p := pretend.Load(); p != nil && p.name == fi.Name() {
		size = p.size
	}
	w.u64(size)
	w.u32(modeOf(fi))
	w.u32(uint32(fi.ModTime().Unix()))
	w.u32(uint32(fi.ModTime().Unix()))
}

// The POSIX mode, as a box reports it: the kind in the high bits, then the permissions.
func modeOf(fi os.FileInfo) uint32 {
	m := uint32(fi.Mode().Perm())
	switch {
	case fi.IsDir():
		m |= 0o040000
	case fi.Mode()&os.ModeSymlink != 0:
		m |= 0o120000
	case fi.Mode()&os.ModeNamedPipe != 0:
		m |= 0o010000
	case fi.Mode()&os.ModeSocket != 0:
		m |= 0o140000
	case fi.Mode()&os.ModeDevice != 0:
		m |= 0o020000
	default:
		m |= 0o100000
	}
	return m
}

type take struct {
	b   []byte
	bad bool
}

func (r *take) u32() uint32 {
	if r.bad || len(r.b) < 4 {
		r.bad = true
		return 0
	}
	v := binary.BigEndian.Uint32(r.b)
	r.b = r.b[4:]
	return v
}

func (r *take) u64() uint64 {
	if r.bad || len(r.b) < 8 {
		r.bad = true
		return 0
	}
	v := binary.BigEndian.Uint64(r.b)
	r.b = r.b[8:]
	return v
}

func (r *take) str() []byte {
	n := r.u32()
	if r.bad || uint64(n) > uint64(len(r.b)) {
		r.bad = true
		return nil
	}
	v := r.b[:n]
	r.b = r.b[n:]
	return v
}

func readPacket(r io.Reader) (byte, []byte, error) {
	var head [4]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	n := binary.BigEndian.Uint32(head[:])
	if n < 1 || n > 1<<18 {
		return 0, nil, io.ErrUnexpectedEOF
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return 0, nil, err
	}
	return buf[0], buf[1:], nil
}

func writePacket(w io.Writer, kind byte, body []byte) error {
	var head [5]byte
	binary.BigEndian.PutUint32(head[:4], uint32(len(body)+1))
	head[4] = kind
	if _, err := w.Write(head[:]); err != nil {
		return err
	}
	_, err := w.Write(body)
	return err
}
