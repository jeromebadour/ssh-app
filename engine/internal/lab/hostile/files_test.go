package hostile

import (
	"os"
	"testing"
)

// The ten characters at the front of an `ls -l` line, as a box prints them. Go's own FileMode.String writes a
// capital L for a link and letters of its own elsewhere, which no box prints, so a lab that used it would be
// standing in for nothing: the app would be read against a line it will never meet on a real box.
func TestModeLineIsWhatABoxPrints(t *testing.T) {
	for _, c := range []struct {
		mode os.FileMode
		want string
	}{
		{0o644, "-rw-r--r--"},
		{0o755 | os.ModeDir, "drwxr-xr-x"},
		{0o777 | os.ModeSymlink, "lrwxrwxrwx"},
		{0o600, "-rw-------"},
		{0o644 | os.ModeNamedPipe, "prw-r--r--"},
		{0o666 | os.ModeDevice | os.ModeCharDevice, "crw-rw-rw-"},
	} {
		if got := modeLine(c.mode); got != c.want {
			t.Errorf("modeLine(%v) = %q, wanted %q", c.mode, got, c.want)
		}
	}
}
