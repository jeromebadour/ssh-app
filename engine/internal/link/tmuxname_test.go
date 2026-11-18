package link

import (
	"strings"
	"testing"
)

func TestStartInTmux(t *testing.T) {
	for _, c := range []struct{ folder, tmux, want string }{
		{"/srv/app", "work", `tmux -L berth -f /dev/null has-session -t 'work' 2>/dev/null || cd -- '/srv/app' || exit 2; exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'work'`},
		{"", "work", `exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'work'`},
		{"/srv/it's", "a_b-1", `tmux -L berth -f /dev/null has-session -t 'a_b-1' 2>/dev/null || cd -- '/srv/it'\''s' || exit 2; exec tmux -L berth -f /dev/null set -g mouse on \; new-session -A -s 'a_b-1'`},
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
		// The folder's one and only place in the command is inside the shell's own cd, and nothing before
		// that cd carries any of it: what runs first is this app's own words with only the place's name in
		// them, and that name is held to letters, digits, dash and underscore.
		if strings.Count(got, folder) != 1 {
			t.Fatalf("%q: the folder appears %d times: %q", folder, strings.Count(got, folder), got)
		}
		if !strings.Contains(got, "cd -- '"+folder+"'") {
			t.Fatalf("%q: the folder is not reached by the shell's own cd: %q", folder, got)
		}
		if before := got[:strings.Index(got, "cd -- '")]; strings.Contains(before, "#") {
			t.Fatalf("%q: something before the cd carries the folder: %q", folder, before)
		}
	}
}

// A place that keeps running is where a long job lives, and its folder can go while the job does not. The
// cd must be on the way to making a session and not on the way to one that is already there, or a deleted
// folder locks him out of his own running job: before this, the cd failed and the command failed with it.
func TestAKeepsRunningPlaceIsReachedWithoutItsFolder(t *testing.T) {
	got, err := StartIn("/srv/app", "work")
	if err != nil {
		t.Fatal(err)
	}
	ask := strings.Index(got, "has-session")
	cd := strings.Index(got, "cd -- ")
	attach := strings.Index(got, "new-session")
	if ask < 0 || cd < 0 || attach < 0 {
		t.Fatalf("the three parts must all be there: %q", got)
	}
	if !(ask < cd && cd < attach) {
		t.Fatalf("the session must be asked after before the cd, and the cd before the attach: %q", got)
	}
	if !strings.Contains(got, "|| cd -- '/srv/app' || exit 2;") {
		t.Fatalf("a folder that is not there must still end it, and only on the way to a new session: %q", got)
	}
	// A place with no folder of its own has nothing to cd to and asks nothing first.
	bare, err := StartIn("", "work")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(bare, "has-session") || strings.Contains(bare, "cd") {
		t.Fatalf("with no folder there is nothing to ask or to cd to: %q", bare)
	}
}
