package main

import "testing"

func TestCheckExposureLocalhostOnly(t *testing.T) {
	for addr, ok := range map[string]bool{
		"127.0.0.1:3460": true, "localhost:1": true, "[::1]:1": true,
		":3460": false, "0.0.0.0:1": false, "192.168.1.5:3460": false, "[::]:1": false, "nope": false,
	} {
		if err := checkExposure(addr); (err == nil) != ok {
			t.Errorf("%s: %v", addr, err)
		}
	}
}
