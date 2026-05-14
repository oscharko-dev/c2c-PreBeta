package com.c2c.w0.parser;

import org.junit.jupiter.api.Test;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class CobolParserTest {
    private final CobolParser parser = new CobolParser();

    @Test
    void parsesSelectedW0CorpusPrograms() throws Exception {
        for (String fixture : new String[]{
                "branch-account-guard.cbl",
                "ctrl-decimal-payroll.cbl",
                "decimal-batch-aggregator.cbl",
        }) {
            Model.ParseRequest request = new Model.ParseRequest();
            request.runId = "test-run";
            request.workflowId = "w0-migration-v0";
            request.source = Files.readString(Path.of("../../corpus/synthetic/programs", fixture));

            Model.ParseResult result = parser.parse(request);

            assertEquals("ok", result.status, fixture);
            assertFalse(result.program.dataItems.isEmpty(), fixture);
            assertFalse(result.program.statements.isEmpty(), fixture);
            assertFalse(result.program.controlFlow.isEmpty(), fixture);
            assertNotNull(result.sourceRef.sha256, fixture);
        }
    }

    @Test
    void unsupportedFileIoFailsWithExplicitDiagnostics() {
        Model.ParseRequest request = new Model.ParseRequest();
        request.source = """
               IDENTIFICATION DIVISION.
               PROGRAM-ID. BADIO.
               DATA DIVISION.
               FILE SECTION.
               FD INPUT-FILE.
               PROCEDURE DIVISION.
                   OPEN INPUT INPUT-FILE
                   READ INPUT-FILE
                   STOP RUN.
               """;

        Model.ParseResult result = parser.parse(request);

        assertEquals("failed", result.status);
        assertTrue(result.diagnostics.stream().anyMatch(d -> "unsupported-feature".equals(d.code)));
    }

    @Test
    void malformedDataDeclarationFailsExplicitly() {
        Model.ParseRequest request = new Model.ParseRequest();
        request.source = """
               IDENTIFICATION DIVISION.
               PROGRAM-ID. BADDATA.
               DATA DIVISION.
               WORKING-STORAGE SECTION.
               XX INVALID DECL.
               PROCEDURE DIVISION.
                   STOP RUN.
               """;
        Model.ParseResult result = parser.parse(request);
        assertEquals("failed", result.status);
        assertTrue(result.diagnostics.stream().anyMatch(d -> "unsupported-data-declaration".equals(d.code)));
    }
}
