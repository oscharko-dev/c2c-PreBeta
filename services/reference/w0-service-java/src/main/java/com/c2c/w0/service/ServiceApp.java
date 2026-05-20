package com.c2c.w0.service;

public final class ServiceApp {
    private ServiceApp() {}

    public static double computeNet(double grossSalary, int employees, double taxRate) {
        double gross = grossSalary * employees;
        double tax = gross * taxRate;
        double net = gross - tax;
        return Math.round(net * 100.0) / 100.0;
    }

    public static void main(String[] args) {
        System.out.printf("NET=%1$.2f%n", computeNet(125.75, 8, 0.1887));
    }
}
