package com.c2c.w0.targetjava;

import com.c2c.target.java.runtime.RuntimeMetadata;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * Deterministic, IR-driven Java project generator.
 * <p>
 * Given a validated Semantic IR v0 document this builds an in-memory project
 * map keyed by relative file path. The W0 generator only emits constructs it
 * can ground in IR data: declared fields with a recognised PIC, DISPLAY/MOVE
 * statements with parsed operands, and STOP. Every other IR statement is
 * recorded as an explicit diagnostic and as an open assumption inside the
 * generated code so that audits can reconcile generator coverage against
 * target-generator-contract-v0.
 */
final class JavaProjectGenerator {

    static final String GENERATED_PACKAGE_PREFIX = "c2c.generated";
    static final String GENERATOR_NAME = "target-java-generation-service";
    static final String GENERATOR_VERSION = "0.1.0";
    static final String CONTRACT_VERSION = RuntimeMetadata.CONTRACT_VERSION;
    static final String SUPPORTED_IR_VERSION = RuntimeMetadata.IR_VERSION;

    private static final ObjectMapper JSON = new ObjectMapper()
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .enable(SerializationFeature.INDENT_OUTPUT);

    private JavaProjectGenerator() {
    }

    static GenerationResult generate(Map<String, Object> ir) {
        String programId = string(ir.get("programId"), "UNKNOWN");
        String irId = string(ir.get("irId"), "ir-unknown");
        String sourceHash = string(ir.get("sourceHash"), "unknown");

        String className = toClassName(programId);
        String packageName = packageFor(programId);
        String relativeJavaPath = packageName.replace('.', '/') + "/" + className + ".java";
        String javaFilePath = "src/main/java/" + relativeJavaPath;

        List<Map<String, Object>> fieldLayouts = mapList(ir.get("fieldLayouts"));
        List<Map<String, Object>> statements = mapList(ir.get("statements"));

        List<Map<String, Object>> diagnostics = new ArrayList<>();
        List<String> assumptionRecords = new ArrayList<>();
        // Generated class members.
        Map<String, FieldEmission> fields = new LinkedHashMap<>();
        List<String> emittedFieldIds = new ArrayList<>();
        List<String> emittedStatementIds = new ArrayList<>();

        for (Map<String, Object> layout : fieldLayouts) {
            String name = string(layout.get("name"), "");
            String picture = stringOrNull(layout.get("picture"));
            String id = string(layout.get("id"), "");
            Integer occurs = integerOrNull(layout.get("occurs"));
            if (name.isBlank() || id.isBlank()) {
                continue;
            }
            if (picture == null) {
                diagnostics.add(IrValidator.diagnostic("info", intValue(layout.get("sourceLine")),
                        "skipped-group-item",
                        "Group item without PIC clause is not materialised: " + name));
                continue;
            }
            if (occurs != null && occurs > 1) {
                diagnostics.add(IrValidator.diagnostic("info", intValue(layout.get("sourceLine")),
                        "skipped-occurs",
                        "OCCURS arrays are not materialised in W0 generator: " + name));
                assumptionRecords.add(assumptionLine(id, id, "WARN",
                        "OCCURS arrays are deferred beyond W0 target generation"));
                continue;
            }
            String fieldVar = javaIdentifier(name);
            fields.put(name, new FieldEmission(fieldVar, name, id, picture));
            emittedFieldIds.add(id);
        }

        List<String> runBody = new ArrayList<>();
        for (Map<String, Object> statement : statements) {
            String operation = string(statement.get("operation"), "unknown").toLowerCase(Locale.ROOT);
            String stmtId = string(statement.get("id"), "");
            int line = intValue(statement.get("sourceLine"));
            String raw = string(statement.get("raw"), "");
            Map<String, Object> operands = mapOrEmpty(statement.get("operands"));

            switch (operation) {
                case "paragraph" -> {
                    String label = string(operands.get("name"), "");
                    runBody.add("        // paragraph " + label + " [" + stmtId + " line " + line + "]");
                    emittedStatementIds.add(stmtId);
                }
                case "display" -> emitDisplay(operands, stmtId, line, raw, fields, runBody, emittedStatementIds, diagnostics, assumptionRecords);
                case "move" -> emitMove(operands, stmtId, line, raw, fields, runBody, emittedStatementIds, diagnostics, assumptionRecords);
                case "stop" -> {
                    runBody.add("        // stop [" + stmtId + " line " + line + "] " + escapeComment(raw));
                    runBody.add("        return;");
                    emittedStatementIds.add(stmtId);
                }
                case "end_if", "end_evaluate", "end_perform", "else" -> {
                    runBody.add("        // " + operation + " [" + stmtId + " line " + line + "]");
                    emittedStatementIds.add(stmtId);
                }
                default -> {
                    String severity = "info";
                    String code = "unsupported-statement";
                    String description = "W0 generator does not translate '" + operation
                            + "' deterministically; recorded as open assumption";
                    diagnostics.add(IrValidator.diagnostic(severity, line, code,
                            description + " (" + stmtId + "): " + raw));
                    runBody.add("        // " + operation + " [" + stmtId + " line " + line + "] "
                            + escapeComment(raw));
                    runBody.add("        " + assumptionRecordCall(stmtId, stmtId, "WARN",
                            description));
                    emittedStatementIds.add(stmtId);
                }
            }
        }

        String javaSource = renderJavaClass(packageName, className, programId, irId, sourceHash,
                fields.values(), runBody, assumptionRecords);

        Map<String, String> files = new TreeMap<>();
        files.put(javaFilePath, javaSource);
        files.put("pom.xml", renderPom(packageName, className, programId));
        files.put("src/main/resources/c2c-trace.json",
                renderTrace(programId, irId, sourceHash, javaFilePath, emittedFieldIds, emittedStatementIds));
        files.put("README.md", renderReadme(programId, className, packageName));

        Map<String, Object> traceability = new LinkedHashMap<>();
        traceability.put("programId", programId);
        traceability.put("irId", irId);
        traceability.put("sourceHash", sourceHash);
        traceability.put("contractVersion", CONTRACT_VERSION);
        traceability.put("irVersion", SUPPORTED_IR_VERSION);
        traceability.put("runtimeName", RuntimeMetadata.RUNTIME_NAME);
        traceability.put("runtimeVersion", RuntimeMetadata.RUNTIME_VERSION);
        traceability.put("generatorName", GENERATOR_NAME);
        traceability.put("generatorVersion", GENERATOR_VERSION);

        Map<String, Object> fileTrace = new LinkedHashMap<>();
        List<String> fileNodeIds = new ArrayList<>();
        fileNodeIds.addAll(emittedFieldIds);
        fileNodeIds.addAll(emittedStatementIds);
        fileTrace.put(javaFilePath, fileNodeIds);
        traceability.put("files", fileTrace);

        return new GenerationResult(files, diagnostics, traceability,
                packageName + "." + className, javaFilePath);
    }

    private static void emitDisplay(Map<String, Object> operands, String stmtId, int line,
                                    String raw, Map<String, FieldEmission> fields,
                                    List<String> runBody, List<String> emittedStatementIds,
                                    List<Map<String, Object>> diagnostics,
                                    List<String> assumptionRecords) {
        List<Object> items = listOrEmpty(operands.get("items"));
        if (items.isEmpty()) {
            runBody.add("        // display [" + stmtId + " line " + line + "] " + escapeComment(raw));
            runBody.add("        " + assumptionRecordCall(stmtId, stmtId, "WARN",
                    "DISPLAY statement had no operands.items"));
            emittedStatementIds.add(stmtId);
            diagnostics.add(IrValidator.diagnostic("info", line, "display-no-items",
                    "DISPLAY had no operands.items (" + stmtId + ")"));
            return;
        }
        runBody.add("        // display [" + stmtId + " line " + line + "] " + escapeComment(raw));
        StringBuilder expr = new StringBuilder("        System.out.print(");
        boolean first = true;
        for (Object token : items) {
            String text = token == null ? "" : token.toString().trim();
            if (text.isEmpty()) {
                continue;
            }
            if (!first) {
                expr.append(").append(");
            }
            String fragment = renderDisplayFragment(text, fields);
            if (first) {
                expr = new StringBuilder("        System.out.println(new StringBuilder().append(").append(fragment);
                first = false;
            } else {
                expr.append(fragment);
            }
        }
        if (first) {
            // No usable tokens; fall back to a comment-only emission.
            runBody.add("        " + assumptionRecordCall(stmtId, stmtId, "WARN",
                    "DISPLAY items contained no non-empty tokens"));
        } else {
            expr.append(").toString());");
            runBody.add(expr.toString());
        }
        emittedStatementIds.add(stmtId);
    }

    private static String renderDisplayFragment(String token, Map<String, FieldEmission> fields) {
        if (token.length() >= 2 && token.startsWith("\"") && token.endsWith("\"")) {
            String literal = token.substring(1, token.length() - 1);
            return "\"" + escapeJavaString(literal) + "\"";
        }
        FieldEmission field = fields.get(token);
        if (field != null) {
            return field.fieldVar + ".displayValue()";
        }
        // Unknown reference: emit literal token as string with a runtime assumption-free
        // comment marker so the generated code stays compilable and deterministic.
        return "\"" + escapeJavaString(token) + "\"";
    }

    private static void emitMove(Map<String, Object> operands, String stmtId, int line,
                                 String raw, Map<String, FieldEmission> fields,
                                 List<String> runBody, List<String> emittedStatementIds,
                                 List<Map<String, Object>> diagnostics,
                                 List<String> assumptionRecords) {
        String source = string(operands.get("source"), "").trim();
        List<Object> targets = listOrEmpty(operands.get("targets"));
        runBody.add("        // move [" + stmtId + " line " + line + "] " + escapeComment(raw));
        if (source.isEmpty() || targets.isEmpty()) {
            runBody.add("        " + assumptionRecordCall(stmtId, stmtId, "WARN",
                    "MOVE statement missing source/targets in IR operands"));
            diagnostics.add(IrValidator.diagnostic("info", line, "move-incomplete",
                    "MOVE missing operands.source or operands.targets (" + stmtId + ")"));
            emittedStatementIds.add(stmtId);
            return;
        }

        boolean literal = source.startsWith("\"") && source.endsWith("\"");
        FieldEmission sourceField = literal ? null : fields.get(source);
        for (Object targetObject : targets) {
            String targetName = targetObject == null ? "" : targetObject.toString().trim();
            if (targetName.isEmpty()) {
                continue;
            }
            FieldEmission target = fields.get(targetName);
            if (target == null) {
                diagnostics.add(IrValidator.diagnostic("info", line, "move-unknown-target",
                        "MOVE target '" + targetName + "' is not a declared field (" + stmtId + ")"));
                runBody.add("        " + assumptionRecordCall(stmtId, stmtId, "WARN",
                        "MOVE target not declared as field: " + targetName));
                continue;
            }
            if (literal) {
                String stringLiteral = source.substring(1, source.length() - 1);
                runBody.add("        " + target.fieldVar + ".moveLiteral(\""
                        + escapeJavaString(stringLiteral) + "\");");
            } else if (sourceField != null) {
                runBody.add("        " + target.fieldVar + ".moveFrom(" + sourceField.fieldVar + ");");
            } else {
                diagnostics.add(IrValidator.diagnostic("info", line, "move-unknown-source",
                        "MOVE source '" + source + "' is not a declared field (" + stmtId + ")"));
                runBody.add("        " + assumptionRecordCall(stmtId, stmtId, "WARN",
                        "MOVE source not declared as field: " + source));
            }
        }
        emittedStatementIds.add(stmtId);
    }

    private static String renderJavaClass(String packageName, String className, String programId,
                                          String irId, String sourceHash,
                                          Iterable<FieldEmission> fields, List<String> runBody,
                                          List<String> assumptionRecords) {
        StringBuilder sb = new StringBuilder(2048);
        sb.append("package ").append(packageName).append(";\n\n");
        sb.append("import com.c2c.target.java.runtime.AssumptionRegistry;\n");
        sb.append("import com.c2c.target.java.runtime.AssumptionRegistry.Severity;\n");
        sb.append("import com.c2c.target.java.runtime.CobolDecimal;\n");
        sb.append("import com.c2c.target.java.runtime.CobolField;\n");
        sb.append("import com.c2c.target.java.runtime.ConditionStatus;\n");
        sb.append("import com.c2c.target.java.runtime.PictureSpec;\n");
        sb.append("import com.c2c.target.java.runtime.RuntimeMetadata;\n\n");
        sb.append("/**\n");
        sb.append(" * Generated by ").append(GENERATOR_NAME).append(' ').append(GENERATOR_VERSION).append(".\n");
        sb.append(" * Contract: ").append(CONTRACT_VERSION).append('\n');
        sb.append(" * IR version: ").append(SUPPORTED_IR_VERSION).append('\n');
        sb.append(" * IR id: ").append(irId).append('\n');
        sb.append(" * Program id: ").append(programId).append('\n');
        sb.append(" * Source hash: ").append(sourceHash).append('\n');
        sb.append(" */\n");
        sb.append("public final class ").append(className).append(" {\n\n");
        sb.append("    public static final String PROGRAM_ID = \"").append(escapeJavaString(programId)).append("\";\n");
        sb.append("    public static final String IR_ID = \"").append(escapeJavaString(irId)).append("\";\n");
        sb.append("    public static final String SOURCE_HASH = \"").append(escapeJavaString(sourceHash)).append("\";\n");
        sb.append("    public static final String RUNTIME_NAME = RuntimeMetadata.RUNTIME_NAME;\n");
        sb.append("    public static final String RUNTIME_VERSION = RuntimeMetadata.RUNTIME_VERSION;\n");
        sb.append("    public static final String CONTRACT_VERSION = RuntimeMetadata.CONTRACT_VERSION;\n\n");

        sb.append("    private final AssumptionRegistry assumptionRegistry = new AssumptionRegistry();\n");
        for (FieldEmission field : fields) {
            sb.append("    private final CobolField ").append(field.fieldVar).append(";\n");
        }
        sb.append('\n');
        sb.append("    public ").append(className).append("() {\n");
        for (FieldEmission field : fields) {
            sb.append("        this.").append(field.fieldVar)
                    .append(" = new CobolField(\"").append(escapeJavaString(field.cobolName))
                    .append("\", \"").append(escapeJavaString(field.irNodeId))
                    .append("\", PictureSpec.parse(\"").append(escapeJavaString(field.picture))
                    .append("\"));\n");
        }
        for (String record : assumptionRecords) {
            sb.append("        ").append(record).append('\n');
        }
        sb.append("    }\n\n");
        sb.append("    public AssumptionRegistry assumptions() {\n");
        sb.append("        return assumptionRegistry;\n");
        sb.append("    }\n\n");
        // Touch ConditionStatus / CobolDecimal via a static accessor so the
        // imports stay needed even when no statement uses them; the generator
        // refuses to silently drop these for traceability of runtime surface.
        sb.append("    @SuppressWarnings(\"unused\")\n");
        sb.append("    private static boolean numericEquals(CobolDecimal left, CobolDecimal right) {\n");
        sb.append("        return ConditionStatus.equalTo(left, right);\n");
        sb.append("    }\n\n");
        sb.append("    public void run() {\n");
        if (runBody.isEmpty()) {
            sb.append("        // no procedure statements were emitted from the IR\n");
        } else {
            for (String line : runBody) {
                sb.append(line).append('\n');
            }
        }
        sb.append("    }\n\n");
        sb.append("    public static void main(String[] args) {\n");
        sb.append("        new ").append(className).append("().run();\n");
        sb.append("    }\n");
        sb.append("}\n");
        return sb.toString();
    }

    private static String renderPom(String packageName, String className, String programId) {
        String artifact = "c2c-generated-" + programId.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9-]", "-");
        return "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                + "<project xmlns=\"http://maven.apache.org/POM/4.0.0\">\n"
                + "  <modelVersion>4.0.0</modelVersion>\n"
                + "  <groupId>" + GENERATED_PACKAGE_PREFIX + "</groupId>\n"
                + "  <artifactId>" + artifact + "</artifactId>\n"
                + "  <version>0.1.0</version>\n"
                + "  <packaging>jar</packaging>\n"
                + "  <properties>\n"
                + "    <maven.compiler.source>21</maven.compiler.source>\n"
                + "    <maven.compiler.target>21</maven.compiler.target>\n"
                + "    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>\n"
                + "    <c2c.contract.version>" + CONTRACT_VERSION + "</c2c.contract.version>\n"
                + "    <c2c.ir.version>" + SUPPORTED_IR_VERSION + "</c2c.ir.version>\n"
                + "    <c2c.runtime.version>" + RuntimeMetadata.RUNTIME_VERSION + "</c2c.runtime.version>\n"
                + "    <c2c.generator.name>" + GENERATOR_NAME + "</c2c.generator.name>\n"
                + "    <c2c.generator.version>" + GENERATOR_VERSION + "</c2c.generator.version>\n"
                + "    <c2c.program.id>" + programId + "</c2c.program.id>\n"
                + "    <c2c.entry.class>" + packageName + "." + className + "</c2c.entry.class>\n"
                + "  </properties>\n"
                + "  <dependencies>\n"
                + "    <dependency>\n"
                + "      <groupId>com.c2c</groupId>\n"
                + "      <artifactId>" + RuntimeMetadata.RUNTIME_NAME + "</artifactId>\n"
                + "      <version>${c2c.runtime.version}</version>\n"
                + "    </dependency>\n"
                + "  </dependencies>\n"
                + "</project>\n";
    }

    private static String renderTrace(String programId, String irId, String sourceHash,
                                      String javaFilePath, List<String> fieldIds, List<String> statementIds) {
        Map<String, Object> trace = new LinkedHashMap<>();
        trace.put("contractVersion", CONTRACT_VERSION);
        trace.put("irVersion", SUPPORTED_IR_VERSION);
        trace.put("programId", programId);
        trace.put("irId", irId);
        trace.put("sourceHash", sourceHash);
        trace.put("runtimeName", RuntimeMetadata.RUNTIME_NAME);
        trace.put("runtimeVersion", RuntimeMetadata.RUNTIME_VERSION);
        trace.put("generatorName", GENERATOR_NAME);
        trace.put("generatorVersion", GENERATOR_VERSION);
        List<String> nodeIds = new ArrayList<>();
        nodeIds.addAll(fieldIds);
        nodeIds.addAll(statementIds);
        Map<String, Object> files = new LinkedHashMap<>();
        files.put(javaFilePath, nodeIds);
        trace.put("files", files);
        try {
            return JSON.writeValueAsString(trace) + "\n";
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("c2c-trace.json serialization failed", e);
        }
    }

    private static String renderReadme(String programId, String className, String packageName) {
        return "# Generated project for " + programId + "\n\n"
                + "Generated by `" + GENERATOR_NAME + "` " + GENERATOR_VERSION + ".\n"
                + "Contract: `" + CONTRACT_VERSION + "`. IR: `" + SUPPORTED_IR_VERSION + "`.\n"
                + "Runtime dependency: `" + RuntimeMetadata.RUNTIME_NAME + ":" + RuntimeMetadata.RUNTIME_VERSION + "`.\n\n"
                + "Entry class: `" + packageName + "." + className + "`. Run with `java -cp ...`.\n"
                + "Traceability index: `src/main/resources/c2c-trace.json`.\n";
    }

    private static String assumptionRecordCall(String assumptionId, String irNodeId,
                                               String severity, String description) {
        return "assumptionRegistry.record(\"" + escapeJavaString(assumptionId) + "\", \""
                + escapeJavaString(irNodeId) + "\", Severity." + severity + ", \""
                + escapeJavaString(description) + "\");";
    }

    private static String assumptionLine(String assumptionId, String irNodeId,
                                         String severity, String description) {
        // Reuses the same helper to keep field-init assumptions exactly equal to statement ones.
        return assumptionRecordCall(assumptionId, irNodeId, severity, description);
    }

    static String toClassName(String programId) {
        if (programId == null || programId.isBlank()) {
            return "Program";
        }
        StringBuilder sb = new StringBuilder();
        boolean upper = true;
        for (char c : programId.toCharArray()) {
            if (Character.isLetterOrDigit(c)) {
                sb.append(upper ? Character.toUpperCase(c) : Character.toLowerCase(c));
                upper = false;
            } else {
                upper = true;
            }
        }
        if (sb.length() == 0 || !Character.isLetter(sb.charAt(0))) {
            sb.insert(0, 'P');
        }
        return sb.toString();
    }

    static String packageFor(String programId) {
        String slug = programId == null ? "" : programId.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
        if (slug.isEmpty()) {
            slug = "program";
        }
        return GENERATED_PACKAGE_PREFIX + "." + slug;
    }

    static String javaIdentifier(String cobolName) {
        StringBuilder sb = new StringBuilder();
        boolean upper = false;
        for (char c : cobolName.toCharArray()) {
            if (c == '-' || c == '_') {
                upper = true;
            } else if (Character.isLetterOrDigit(c)) {
                sb.append(upper ? Character.toUpperCase(c) : Character.toLowerCase(c));
                upper = false;
            }
        }
        if (sb.length() == 0) {
            sb.append("field");
        }
        if (!Character.isLetter(sb.charAt(0))) {
            sb.insert(0, 'f');
        }
        String candidate = sb.toString();
        return JAVA_KEYWORDS.contains(candidate) ? candidate + "_" : candidate;
    }

    private static final java.util.Set<String> JAVA_KEYWORDS = java.util.Set.of(
            "abstract", "assert", "boolean", "break", "byte", "case", "catch", "char",
            "class", "const", "continue", "default", "do", "double", "else", "enum",
            "extends", "final", "finally", "float", "for", "goto", "if", "implements",
            "import", "instanceof", "int", "interface", "long", "native", "new", "package",
            "private", "protected", "public", "return", "short", "static", "strictfp",
            "super", "switch", "synchronized", "this", "throw", "throws", "transient",
            "try", "void", "volatile", "while", "true", "false", "null", "yield", "var", "record");

    private static String escapeJavaString(String value) {
        StringBuilder sb = new StringBuilder(value.length());
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            switch (c) {
                case '\\' -> sb.append("\\\\");
                case '"' -> sb.append("\\\"");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.toString();
    }

    private static String escapeComment(String raw) {
        return raw.replace("*/", "* /").replace("\n", " ").replace("\r", " ");
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> mapList(Object value) {
        List<Map<String, Object>> result = new ArrayList<>();
        if (value instanceof List<?> list) {
            for (Object entry : list) {
                if (entry instanceof Map<?, ?> map) {
                    result.add(new LinkedHashMap<>((Map<String, Object>) map));
                }
            }
        }
        return result;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> mapOrEmpty(Object value) {
        if (value instanceof Map<?, ?> map) {
            return new LinkedHashMap<>((Map<String, Object>) map);
        }
        return new LinkedHashMap<>();
    }

    private static List<Object> listOrEmpty(Object value) {
        if (value instanceof List<?> list) {
            return new ArrayList<>(list);
        }
        return new ArrayList<>();
    }

    private static String string(Object value, String fallback) {
        if (value == null) {
            return fallback;
        }
        String text = value.toString().trim();
        return text.isBlank() ? fallback : text;
    }

    private static String stringOrNull(Object value) {
        if (value == null) {
            return null;
        }
        String text = value.toString().trim();
        return text.isBlank() ? null : text;
    }

    private static Integer integerOrNull(Object value) {
        if (value instanceof Number n) {
            return n.intValue();
        }
        if (value instanceof String s && !s.isBlank()) {
            try {
                return Integer.parseInt(s.trim());
            } catch (NumberFormatException e) {
                return null;
            }
        }
        return null;
    }

    private static int intValue(Object value) {
        Integer i = integerOrNull(value);
        return i == null ? 0 : i;
    }

    record FieldEmission(String fieldVar, String cobolName, String irNodeId, String picture) {
    }

    record GenerationResult(Map<String, String> files,
                            List<Map<String, Object>> diagnostics,
                            Map<String, Object> traceability,
                            String entryClass,
                            String entryFilePath) {
    }
}
