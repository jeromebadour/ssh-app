package patience

import (
	"syscall"
	"time"
)

// TCP_USER_TIMEOUT from linux/tcp.h. Package syscall does not name it.
const tcpUserTimeout = 0x12

func set(fd uintptr, d time.Duration) error {
	return syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeout, int(d/time.Millisecond))
}

func get(fd uintptr) (time.Duration, error) {
	ms, err := syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeout)
	return time.Duration(ms) * time.Millisecond, err
}
