package com.c2c.w0.buildtest;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class GeneratedProjectMaterializerTest {

    @Test
    void writesNestedFilesIntoTempRoot() throws Exception {
        Map<String, String> files = Map.of(
                "pom.xml", "<project/>\n",
                "src/main/java/foo/Bar.java", "package foo; public class Bar {}\n"
        );
        try (var project = GeneratedProjectMaterializer.materialise(files)) {
            assertTrue(Files.exists(project.root().resolve("pom.xml")));
            assertTrue(Files.exists(project.root().resolve("src/main/java/foo/Bar.java")));
            assertEquals(1, project.javaSources().size());
        }
    }

    @Test
    void rejectsAbsolutePaths() {
        assertThrows(IllegalArgumentException.class, () ->
                GeneratedProjectMaterializer.materialise(Map.of("/etc/passwd", "x")));
    }

    @Test
    void rejectsParentTraversal() {
        assertThrows(IllegalArgumentException.class, () ->
                GeneratedProjectMaterializer.materialise(Map.of("../escape.txt", "x")));
    }

    @Test
    void rejectsBackslashes() {
        assertThrows(IllegalArgumentException.class, () ->
                GeneratedProjectMaterializer.materialise(Map.of("..\\escape.txt", "x")));
    }

    @Test
    void rejectsEmptyFileMap() {
        assertThrows(IllegalArgumentException.class, () ->
                GeneratedProjectMaterializer.materialise(Map.of()));
    }
}
