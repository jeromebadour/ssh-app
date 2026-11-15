package patience

import (
	"syscall"
	"time"
	"unsafe"
)

// TCP_MAXRT from ws2ipdef.h (the same number golang.org/x/sys/windows names TCP_MAXRT). Whole seconds.
const tcpMaxRT = 5

func set(fd uintptr, d time.Duration) error {
	seconds := int((d + time.Second - 1) / time.Second)
	return syscall.SetsockoptInt(syscall.Handle(fd), syscall.IPPROTO_TCP, tcpMaxRT, seconds)
}

func get(fd uintptr) (time.Duration, error) {
	var seconds int32
	size := int32(unsafe.Sizeof(seconds))
	err := syscall.Getsockopt(syscall.Handle(fd), syscall.IPPROTO_TCP, tcpMaxRT, (*byte)(unsafe.Pointer(&seconds)), &size)
	return time.Duration(seconds) * time.Second, err
}
