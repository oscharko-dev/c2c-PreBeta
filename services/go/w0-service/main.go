package main

import "fmt"

func ComputeGrossPay(baseSalary float64, employeeCount int, taxRate float64) float64 {
	grossPay := baseSalary * float64(employeeCount)
	taxAmount := grossPay * taxRate
	netPay := grossPay - taxAmount
	return roundToCents(netPay)
}

func roundToCents(v float64) float64 {
	return float64(int64(v*100+0.5)) / 100
}

func main() {
	fmt.Printf("W0-GO-SERVICE gross=%0.2f\n", ComputeGrossPay(125.75, 8, 0.1887))
}
