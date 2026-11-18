//go:build windows

package hostile

import "os"

// Windows has no owner of this shape to report, so this box says nothing about one there. The lab's own
// machine is not the thing under test: what is under test is what the app does when a box does say.
func ownerOf(os.FileInfo) (uid, gid uint32, have bool) { return 0, 0, false }
