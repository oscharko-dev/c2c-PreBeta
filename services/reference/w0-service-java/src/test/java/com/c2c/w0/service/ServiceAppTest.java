package com.c2c.w0.service;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ServiceAppTest {
    @Test
    void computeNetMatchesExpected() {
        double net = ServiceApp.computeNet(125.75, 8, 0.1887);
        assertEquals(816.17, net, 0.001);
    }
}
