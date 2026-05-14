package main

import "testing"

func TestComputeGrossPay(t *testing.T) {
	source := ComputeGrossPay(100.00, 2, 0.10)
	if source != 180.00 {
		t.Fatalf("expected 180.00, got %0.2f", source)
	}
}
