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

    @Test
    void preservesDecimalValueLiteralsInDataItems() {
        Model.ParseRequest request = new Model.ParseRequest();
        request.source = """
               IDENTIFICATION DIVISION.
               PROGRAM-ID. VALUES.
               DATA DIVISION.
               WORKING-STORAGE SECTION.
               01 WS-RATE PIC S9V9(4) VALUE +0.1887.
               PROCEDURE DIVISION.
                   STOP RUN.
               """;

        Model.ParseResult result = parser.parse(request);

        assertEquals("ok", result.status);
        assertEquals("+0.1887", result.program.dataItems.getFirst().value);
    }

    @Test
    void keepsIndexedReferencesAsSingleOperands() {
        Model.ParseRequest request = new Model.ParseRequest();
        request.source = """
               IDENTIFICATION DIVISION.
               PROGRAM-ID. INDEXED.
               DATA DIVISION.
               WORKING-STORAGE SECTION.
               01 WS-INDEX PIC 99 VALUE 1.
               01 WS-STATUS PIC X(1) OCCURS 4 TIMES VALUE SPACE.
               PROCEDURE DIVISION.
                   MOVE "A" TO WS-STATUS (WS-INDEX)
                   EVALUATE WS-STATUS (WS-INDEX)
                     WHEN "A"
                       DISPLAY "A"
                   END-EVALUATE
                   STOP RUN.
               """;

        Model.ParseResult result = parser.parse(request);

        assertEquals("ok", result.status);
        Model.Statement move = result.program.statements.stream()
                .filter(statement -> "MOVE".equals(statement.kind))
                .findFirst()
                .orElseThrow();
        assertEquals("WS-STATUS (WS-INDEX)", ((java.util.List<?>) move.operands.get("targets")).getFirst());
        Model.Statement evaluate = result.program.statements.stream()
                .filter(statement -> "EVALUATE".equals(statement.kind))
                .findFirst()
                .orElseThrow();
        assertEquals("WS-STATUS (WS-INDEX)", evaluate.operands.get("selector"));
    }
}
