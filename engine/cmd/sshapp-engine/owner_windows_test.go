//go:build windows

package main

import "os"

// Windows says nothing about an owner of this shape, and the test that uses this is skipped there.
func hostileOwnerOf(os.FileInfo) (uid, gid uint32, have bool) { return 0, 0, false }
