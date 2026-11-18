package link

import (
	"strings"
	"testing"
)

func TestStartInTmux(t *testing.T) {
	for _, c := range []struct{ folder, tmux, want string }{
		{"/srv/app", "work", `cd -- '/srv/app' && exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'work'`},
		{"", "work", `exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'work'`},
		{"/srv/it's", "a_b-1", `cd -- '/srv/it'\''s' && exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'a_b-1'`},
	} {
		got, err := StartIn(c.folder, c.tmux)
		if err != nil || got != c.want {
			t.Fatalf("StartIn(%q,%q) = %q, %v; want %q", c.folder, c.tmux, got, err, c.want)
		}
	}
	for _, bad := range []string{"a b", "a.b", "a:b", "a;reboot", "../x", "a'b", string(make([]byte, 33))} {
		if _, err := StartIn("/srv", bad); err == nil {
			t.Fatalf("StartIn took a name it must refuse: %q", bad)
		}
	}
}

// A folder's name must never become a command on a box. tmux reads its own formats in the start directory it
// is given, so a folder holding #(...) ran as a command there: a string from the window becoming code on a
// box is the one thing this app may never do. The folder reaches the box through the shell's own cd and is
// never handed to tmux at all, and this holds it to that.
func TestATmuxPlacesFolderIsNeverGivenToTmux(t *testing.T) {
	for _, folder := range []string{
		"/tmp/x/#(touch /tmp/pwned)",
		"/srv/#{?pane_dead,x,y}",
		"/srv/#S",
		"/srv/##",
	} {
		got, err := StartIn(folder, "work")
		if err != nil {
			t.Fatalf("%q: %v", folder, err)
		}
		// Everything after the tmux command's own start is this app's own text: the folder is before it.
		at := strings.Index(got, "exec tmux")
		if at < 0 {
			t.Fatalf("%q: no tmux command at all: %q", folder, got)
		}
		if strings.Contains(got[at:], folder) || strings.Contains(got[at:], "#") {
			t.Fatalf("%q: the folder reached tmux: %q", folder, got[at:])
		}
		if !strings.HasPrefix(got, "cd -- '") {
			t.Fatalf("%q: the folder is not reached by the shell's own cd: %q", folder, got)
		}
	}
}
