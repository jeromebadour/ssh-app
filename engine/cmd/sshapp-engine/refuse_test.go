package main

import "testing"

// What may never be deleted from the browser, and what may. The list is judged on a path the box has already
// resolved, so the cases here are the shapes such a path can take.
func TestWhatTheBrowserWillNotDelete(t *testing.T) {
	for _, no := range []string{
		"/", "/etc", "/etc/ssh/sshd_config", "/usr", "/usr/bin/ls", "/boot/grub", "/var/lib", "/var/lib/docker",
		"/bin/sh", "/sbin", "/lib/x86_64-linux-gnu", "/lib64", "/proc/1", "/sys/class", "/dev/null", "/run/lock",
		"/home", "/opt", "/srv", "/var", "/root",
		"/root/.ssh", "/root/.ssh/authorized_keys", "/home/demo/.ssh", "/home/demo/.ssh/id_ed25519",
		"/.berth-trash", "/mnt/data/.berth-trash", "/.berth-trash/2026/a-file",
		"relative/path", "", "/..", "/etc/../etc/passwd", "/usr/../usr",
	} {
		if refuseReason(no) == "" {
			t.Errorf("%q would have been deleted", no)
		}
	}
	for _, yes := range []string{
		"/home/demo/notes.txt", "/opt/app/releases/v1.tar.gz", "/srv/ledger/today.log", "/var/log/syslog",
		"/root/notes.txt", "/mnt/data/dump.sql", "/home/demo/.config/app.conf", "/var/www/html/index.html",
		"/home/demo/sshfolder", "/opt/berth-trash-lookalike",
	} {
		if why := refuseReason(yes); why != "" {
			t.Errorf("%q was refused: %s", yes, why)
		}
	}
}

// A path is judged after it is tidied, so nothing walks through the list by climbing or by doubled slashes.
func TestAPathIsJudgedTidied(t *testing.T) {
	for from, want := range map[string]string{
		"/home/demo/../demo/notes.txt": "/home/demo/notes.txt",
		"//var///log//syslog":          "/var/log/syslog",
		"/var/log/./syslog":            "/var/log/syslog",
		"/home/demo/":                  "/home/demo",
		"/":                            "/",
		"/..":                          "",
		"/home/../..":                  "",
		"home/demo":                    "",
	} {
		if got := tidy(from); got != want {
			t.Errorf("tidy(%q) = %q, want %q", from, got, want)
		}
	}
}
