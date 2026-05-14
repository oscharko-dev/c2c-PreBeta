package com.c2c.w0.buildtest;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;

final class HashUtil {

    private static final ObjectMapper CANONICAL_JSON = new ObjectMapper()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS);

    private HashUtil() {
    }

    static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] hash = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder out = new StringBuilder(hash.length * 2);
            for (byte b : hash) {
                out.append(String.format(Locale.ROOT, "%02x", b));
            }
            return out.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }

    static String canonicalJson(Object payload) {
        try {
            return CANONICAL_JSON.writeValueAsString(payload);
        } catch (JsonProcessingException e) {
            throw new IllegalArgumentException("payload cannot be serialised as JSON", e);
        }
    }

    static int byteLength(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }
}
