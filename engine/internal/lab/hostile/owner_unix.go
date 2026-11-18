//go:build !windows

package hostile

import (
	"os"
	"syscall"
)

// ownerOf is who owns a file, as a real box would report it. A box that cannot say simply does not, and the
// app then has no owner to put back, which is honest rather than a guess.
func ownerOf(fi os.FileInfo) (uid, gid uint32, have bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st == nil {
		return 0, 0, false
	}
	return uint32(st.Uid), uint32(st.Gid), true
}
