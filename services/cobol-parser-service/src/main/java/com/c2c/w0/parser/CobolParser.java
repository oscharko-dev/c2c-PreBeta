package com.c2c.w0.parser;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public final class CobolParser {
    private static final Pattern PROGRAM_ID = Pattern.compile("^PROGRAM-ID\\.?\\s+([A-Z][A-Z0-9-]*)\\.?$");
    private static final Pattern DATA_DECLARATION = Pattern.compile("^(\\d{2})\\s+([A-Z][A-Z0-9-]*)\\s*(.*)$");
    private static final Pattern OCCURS = Pattern.compile("\\bOCCURS\\s+(\\d+)\\s+TIMES\\b");
    private static final Pattern VALUE = Pattern.compile("\\bVALUE\\s+(.+?)(?:\\.|$)");
    private static final Pattern PICTURE = Pattern.compile("\\b(?:PIC|PICTURE)\\s+([A-Z0-9()V+-]+)");

    private enum Division {
        NONE,
        IDENTIFICATION,
        DATA,
        PROCEDURE
    }

    private static final class Block {
        final String kind;
        final String startId;

        Block(String kind, String startId) {
            this.kind = kind;
            this.startId = startId;
        }
    }

    Model.ParseResult parse(Model.ParseRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("request is required");
        }
        if (request.source == null || request.source.isBlank()) {
            throw new IllegalArgumentException("source is required");
        }

        String sourceHash = request.sourceHash == null || request.sourceHash.isBlank()
                ? Model.sha256(request.source)
                : request.sourceHash;
        Model.ParseResult result = new Model.ParseResult();
        result.runId = valueOr(request.runId, "run-unknown");
        result.stepId = valueOr(request.stepId, "1");
        result.workflowId = valueOr(request.workflowId, "w0-migration-v0");
        result.capability = valueOr(request.capability, "cobol.parse");
        result.sourceRef = request.inputRef == null
                ? new Model.Reference("urn:cobol-source/" + sourceHash, sourceHash, request.source.getBytes(StandardCharsets.UTF_8).length, "text/x-cobol", "source")
                : request.inputRef;
        if (result.sourceRef.sha256 == null || result.sourceRef.sha256.isBlank()) {
            result.sourceRef.sha256 = sourceHash;
        }
        if (result.sourceRef.byteSize <= 0) {
            result.sourceRef.byteSize = request.source.getBytes(StandardCharsets.UTF_8).length;
        }
        if (result.sourceRef.mimeType == null || result.sourceRef.mimeType.isBlank()) {
            result.sourceRef.mimeType = "text/x-cobol";
        }
        if (result.sourceRef.kind == null || result.sourceRef.kind.isBlank()) {
            result.sourceRef.kind = "source";
        }
        result.program = new Model.ParsedProgram("UNKNOWN", sourceHash);

        Division division = Division.NONE;
        Deque<Block> blocks = new ArrayDeque<>();
        String previousStatementId = null;
        int statementSeq = 0;
        int lineNo = 0;

        for (String rawLine : request.source.split("\\R", -1)) {
            lineNo++;
            String line = normalizeLine(rawLine);
            if (line.isBlank()) {
                continue;
            }
            String upper = line.toUpperCase(Locale.ROOT);

            Division nextDivision = divisionFrom(upper);
            if (nextDivision != Division.NONE) {
                division = nextDivision;
                result.program.divisions.add(new Model.Division(nextDivision.name().toLowerCase(Locale.ROOT), lineNo));
                continue;
            }

            if (isUnsupportedFeature(upper)) {
                result.diagnostics.add(new Model.Diagnostic("error", lineNo, "unsupported-feature", "Unsupported W0 COBOL feature: " + upper));
                continue;
            }

            if (division == Division.IDENTIFICATION) {
                Matcher matcher = PROGRAM_ID.matcher(upper);
                if (matcher.matches()) {
                    result.program.programId = matcher.group(1);
                }
                continue;
            }

            if (division == Division.DATA) {
                Model.DataItem item = parseDataItem(upper, lineNo, sourceHash, result);
                if (item != null) {
                    result.program.dataItems.add(item);
                }
                continue;
            }

            if (division == Division.PROCEDURE) {
                StatementParse statement = parseStatement(upper, rawLine.trim(), lineNo, ++statementSeq, result);
                if (statement == null) {
                    continue;
                }
                result.program.statements.add(statement.statement);
                if (previousStatementId != null) {
                    result.program.controlFlow.add(new Model.ControlEdge(previousStatementId, statement.statement.id, "next"));
                }
                if (statement.opensBlock) {
                    blocks.push(new Block(statement.statement.kind, statement.statement.id));
                }
                if (statement.closesBlock) {
                    closeBlock(blocks, statement.statement, result);
                }
                if (!blocks.isEmpty() && List.of("WHEN", "ELSE").contains(statement.statement.kind)) {
                    result.program.controlFlow.add(new Model.ControlEdge(blocks.peek().startId, statement.statement.id, "branch"));
                }
                previousStatementId = statement.statement.id;
            }
        }

        while (!blocks.isEmpty()) {
            Block block = blocks.pop();
            result.diagnostics.add(new Model.Diagnostic("error", 0, "unterminated-block", "Unterminated " + block.kind + " block"));
        }

        result.assumptions.add("W0 assumes display-compatible fixed-point decimal semantics for PIC S9/V fields.");
        result.assumptions.add("W0 control-flow edges are structural and intentionally conservative.");
        result.program.assumptions.addAll(result.assumptions);
        result.status = result.diagnostics.stream().anyMatch(d -> "error".equals(d.severity)) ? "failed" : "ok";
        result.message = "ok".equals(result.status) ? "COBOL source parsed" : "COBOL source contains unsupported W0 constructs";
        return result;
    }

    private static void closeBlock(Deque<Block> blocks, Model.Statement statement, Model.ParseResult result) {
        if (blocks.isEmpty()) {
            result.diagnostics.add(new Model.Diagnostic("error", statement.line, "unmatched-block-end", "No open block matches " + statement.kind));
            return;
        }
        Block block = blocks.pop();
        boolean matches = (block.kind.equals("IF") && statement.kind.equals("END_IF"))
                || (block.kind.equals("EVALUATE") && statement.kind.equals("END_EVALUATE"))
                || (block.kind.equals("PERFORM") && statement.kind.equals("END_PERFORM"));
        if (!matches) {
            result.diagnostics.add(new Model.Diagnostic("error", statement.line, "mismatched-block-end", "Block end does not match " + block.kind));
            return;
        }
        result.program.controlFlow.add(new Model.ControlEdge(block.startId, statement.id, "block-exit"));
    }

    private static Model.DataItem parseDataItem(String upper, int lineNo, String sourceHash, Model.ParseResult result) {
        Matcher matcher = DATA_DECLARATION.matcher(stripTrailingPeriod(upper));
        if (!matcher.matches()) {
            if (!(upper.endsWith("SECTION.") || upper.endsWith("SECTION"))) {
                result.diagnostics.add(new Model.Diagnostic("error", lineNo, "unsupported-data-declaration",
                        "Unsupported W0 DATA declaration: " + upper));
            }
            return null;
        }

        String rest = matcher.group(3).trim();
        Model.DataItem item = new Model.DataItem();
        item.level = Integer.parseInt(matcher.group(1));
        item.name = matcher.group(2);
        item.line = lineNo;
        item.id = "d-" + Model.stableToken(item.name) + "-" + shortHash(sourceHash + "|data|" + item.name);
        item.picture = match(PICTURE, rest);
        item.value = match(VALUE, rest);
        item.occurs = intMatch(OCCURS, rest);
        item.numeric = item.picture != null && item.picture.contains("9");
        item.signed = item.picture != null && item.picture.startsWith("S");
        item.scale = scale(item.picture);
        item.group = item.picture == null;
        item.byteSize = byteSize(item.picture, item.occurs);
        if (rest.contains("DEPENDING ON")) {
            item.occursDependingOn = rest.substring(rest.indexOf("DEPENDING ON") + "DEPENDING ON".length()).trim();
        }
        if (rest.contains("REDEFINES") || rest.contains("RENAMES")) {
            item.assumptions.add("REDEFINES/RENAMES are tracked as assumptions in W0.");
            result.assumptions.add("REDEFINES/RENAMES data layouts require later-wave expansion.");
        }
        return item;
    }

    private static StatementParse parseStatement(String upper, String raw, int lineNo, int sequence, Model.ParseResult result) {
        String statementText = stripTrailingPeriod(upper);
        if (statementText.isBlank()) {
            return null;
        }

        String kind = firstToken(statementText);
        boolean opens = false;
        boolean closes = false;
        Map<String, Object> operands = new LinkedHashMap<>();

        if (statementText.equals("END-IF")) {
            kind = "END_IF";
            closes = true;
        } else if (statementText.equals("END-EVALUATE")) {
            kind = "END_EVALUATE";
            closes = true;
        } else if (statementText.equals("END-PERFORM")) {
            kind = "END_PERFORM";
            closes = true;
        } else if (statementText.equals("ELSE")) {
            kind = "ELSE";
        } else if (statementText.startsWith("IF ")) {
            kind = "IF";
            opens = true;
            operands.put("condition", statementText.substring(3).trim());
        } else if (statementText.startsWith("EVALUATE ")) {
            kind = "EVALUATE";
            opens = true;
            operands.put("selector", statementText.substring(9).trim());
        } else if (statementText.startsWith("WHEN ")) {
            kind = "WHEN";
            operands.put("value", statementText.substring(5).trim());
        } else if (statementText.startsWith("PERFORM ")) {
            kind = "PERFORM";
            opens = statementText.contains(" UNTIL ") || statementText.contains(" VARYING ");
            operands.put("tokens", List.of(statementText.split("\\s+")));
        } else if (statementText.startsWith("MOVE ")) {
            kind = "MOVE";
            parseMove(statementText, operands);
        } else if (statementText.startsWith("DISPLAY ")) {
            kind = "DISPLAY";
            operands.put("items", splitArguments(statementText.substring(8)));
        } else if (statementText.startsWith("COMPUTE ")) {
            kind = "COMPUTE";
            parseAssignment(statementText.substring(8), operands);
        } else if (List.of("ADD", "SUBTRACT", "MULTIPLY", "DIVIDE").contains(kind)) {
            operands.put("tokens", List.of(statementText.split("\\s+")));
        } else if (statementText.startsWith("CALL ")) {
            kind = "CALL";
            operands.put("target", statementText.substring(5).trim());
            result.assumptions.add("CALL is accepted only as a documented no-op shim in W0.");
        } else if (statementText.equals("STOP RUN")) {
            kind = "STOP";
        } else if (statementText.matches("[A-Z][A-Z0-9-]*")) {
            kind = "PARAGRAPH";
            operands.put("name", statementText);
        } else {
            result.diagnostics.add(new Model.Diagnostic("error", lineNo, "unsupported-statement", "Unsupported W0 procedure statement: " + statementText));
            return null;
        }

        Model.Statement statement = new Model.Statement();
        statement.kind = kind;
        statement.line = lineNo;
        statement.raw = raw;
        statement.id = "s-" + Model.stableToken(kind) + "-" + shortHash(raw.toUpperCase(Locale.ROOT) + "|" + sequence);
        statement.operands.putAll(operands);
        return new StatementParse(statement, opens, closes);
    }
    private static String shortHash(String value) {
        return Model.sha256(value).substring(0, 12);
    }

    private static void parseMove(String statementText, Map<String, Object> operands) {
        String body = statementText.substring(5);
        int to = body.indexOf(" TO ");
        if (to < 0) {
            operands.put("raw", body);
            return;
        }
        operands.put("source", body.substring(0, to).trim());
        operands.put("targets", splitArguments(body.substring(to + 4)));
    }

    private static void parseAssignment(String body, Map<String, Object> operands) {
        int equals = body.indexOf('=');
        if (equals < 0) {
            operands.put("expression", body.trim());
            return;
        }
        operands.put("target", body.substring(0, equals).trim());
        operands.put("expression", body.substring(equals + 1).trim());
    }

    private static List<String> splitArguments(String value) {
        List<String> result = new ArrayList<>();
        Matcher matcher = Pattern.compile("\"[^\"]*\"|\\S+").matcher(value);
        while (matcher.find()) {
            result.add(matcher.group());
        }
        return result;
    }

    private static boolean isUnsupportedFeature(String upper) {
        return upper.startsWith("EXEC ")
                || upper.startsWith("FILE SECTION")
                || upper.startsWith("SELECT ")
                || upper.startsWith("FD ")
                || upper.startsWith("READ ")
                || upper.startsWith("WRITE ")
                || upper.startsWith("OPEN ")
                || upper.startsWith("CLOSE ")
                || upper.startsWith("SORT ")
                || upper.startsWith("MERGE ");
    }

    private static Division divisionFrom(String upper) {
        if (upper.startsWith("IDENTIFICATION DIVISION")) {
            return Division.IDENTIFICATION;
        }
        if (upper.startsWith("DATA DIVISION")) {
            return Division.DATA;
        }
        if (upper.startsWith("PROCEDURE DIVISION")) {
            return Division.PROCEDURE;
        }
        return Division.NONE;
    }

    private static String normalizeLine(String raw) {
        if (raw == null) {
            return "";
        }
        String line = raw.trim();
        if (line.startsWith("*") || line.startsWith("*>")) {
            return "";
        }
        return line;
    }

    private static String stripTrailingPeriod(String value) {
        String text = value.trim();
        return text.endsWith(".") ? text.substring(0, text.length() - 1).trim() : text;
    }

    private static String firstToken(String value) {
        int idx = value.indexOf(' ');
        return idx < 0 ? value : value.substring(0, idx);
    }

    private static String valueOr(String value, String fallback) {
        return value == null || value.isBlank() ? fallback : value;
    }

    private static String match(Pattern pattern, String value) {
        Matcher matcher = pattern.matcher(value);
        return matcher.find() ? matcher.group(1).trim() : null;
    }

    private static Integer intMatch(Pattern pattern, String value) {
        Matcher matcher = pattern.matcher(value);
        return matcher.find() ? Integer.parseInt(matcher.group(1)) : null;
    }

    private static int scale(String picture) {
        if (picture == null) {
            return 0;
        }
        int v = picture.indexOf('V');
        if (v < 0) {
            return 0;
        }
        return symbolWidth(picture.substring(v + 1), '9');
    }

    private static int byteSize(String picture, Integer occurs) {
        if (picture == null) {
            return 0;
        }
        String normalized = picture.startsWith("S") ? picture.substring(1) : picture;
        int size = symbolWidth(normalized.replace("V", ""), '9') + symbolWidth(normalized.replace("V", ""), 'X');
        return size * Math.max(1, occurs == null ? 1 : occurs);
    }

    private static int symbolWidth(String text, char symbol) {
        int width = 0;
        Matcher matcher = Pattern.compile(Pattern.quote(String.valueOf(symbol)) + "(?:\\((\\d+)\\))?").matcher(text);
        while (matcher.find()) {
            width += matcher.group(1) == null ? 1 : Integer.parseInt(matcher.group(1));
        }
        return width;
    }

    private record StatementParse(Model.Statement statement, boolean opensBlock, boolean closesBlock) {
    }
}
