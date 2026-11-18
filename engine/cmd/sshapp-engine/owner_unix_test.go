//go:build !windows

package main

import (
	"os"
	"syscall"
)

// hostileOwnerOf is the same reading of a file's owner the lab box does, so a test can compare what the box
// would have said with what the app asked for.
func hostileOwnerOf(fi os.FileInfo) (uid, gid uint32, have bool) {
	st, ok := fi.Sys().(*syscall.Stat_t)
	if !ok || st == nil {
		return 0, 0, false
	}
	return uint32(st.Uid), uint32(st.Gid), true
}
