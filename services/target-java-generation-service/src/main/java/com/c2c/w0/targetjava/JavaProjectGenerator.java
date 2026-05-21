package com.c2c.w0.targetjava;

import com.c2c.target.java.runtime.RuntimeMetadata;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;

/**
 * Deterministic, IR-driven Java project generator.
 * <p>
 * The W0 generator emits executable Java for the supported corpus subset:
 * declared fields, OCCURS arrays, MOVE, DISPLAY, COMPUTE, ADD/SUBTRACT/
 * MULTIPLY/DIVIDE, IF/ELSE, EVALUATE/WHEN, and PERFORM UNTIL/VARYING blocks.
 * Unsupported or malformed IR nodes are not silently ignored; they produce
 * explicit diagnostics and runtime assumption records while keeping the emitted
 * project compilable for auditability.
 */
final class JavaProjectGenerator {

    static final String GENERATED_PACKAGE_PREFIX = "c2c.generated";
    static final String GENERATOR_NAME = "target-java-generation-service";
    static final String GENERATOR_VERSION = "0.1.0";
    static final String CONTRACT_VERSION = RuntimeMetadata.CONTRACT_VERSION;
    static final String SUPPORTED_IR_VERSION = RuntimeMetadata.IR_VERSION;

    private static final int LOOP_GUARD_LIMIT = 10_000;
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
        Map<String, FieldEmission> fields = new LinkedHashMap<>();
        List<String> emittedFieldIds = new ArrayList<>();
        List<String> emittedStatementIds = new ArrayList<>();

        for (Map<String, Object> layout : fieldLayouts) {
            String name = string(layout.get("name"), "");
            String picture = stringOrNull(layout.get("picture"));
            String id = string(layout.get("id"), "");
            int occurs = Math.max(1, intValue(layout.get("occurs"), 1));
            boolean numeric = booleanValue(layout.get("numeric"), false);
            String initialValue = stringOrNull(layout.get("value"));
            if (name.isBlank() || id.isBlank()) {
                continue;
            }
            if (picture == null) {
                diagnostics.add(IrValidator.diagnostic("info", intValue(layout.get("sourceLine")),
                        "skipped-group-item",
                        "Group item without PIC clause is not materialised: " + name));
                continue;
            }
            String fieldVar = javaIdentifier(name);
            fields.put(name, new FieldEmission(fieldVar, name, id, picture, occurs, numeric, initialValue));
            emittedFieldIds.add(id);
        }

        List<String> runBody = new ArrayList<>();
        EmissionState state = new EmissionState(fields, diagnostics, assumptionRecords, emittedStatementIds);
        CodeBuilder code = new CodeBuilder(runBody);
        for (Map<String, Object> statement : statements) {
            emitStatement(statement, state, code);
        }
        closeOpenBlocks(state, code);

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

    private static void emitStatement(Map<String, Object> statement, EmissionState state, CodeBuilder code) {
        String operation = string(statement.get("operation"), "unknown").toLowerCase(Locale.ROOT);
        String stmtId = string(statement.get("id"), "");
        int line = intValue(statement.get("sourceLine"));
        String raw = string(statement.get("raw"), "");
        Map<String, Object> operands = mapOrEmpty(statement.get("operands"));

        switch (operation) {
            case "paragraph" -> {
                String label = string(operands.get("name"), "");
                code.add("// paragraph " + label + " [" + stmtId + " line " + line + "]");
                state.emittedStatementIds.add(stmtId);
            }
            case "display" -> emitDisplay(operands, stmtId, line, raw, state, code);
            case "move" -> emitMove(operands, stmtId, line, raw, state, code);
            case "compute" -> emitCompute(operands, stmtId, line, raw, state, code);
            case "add" -> emitAdd(operands, stmtId, line, raw, state, code);
            case "subtract" -> emitSubtract(operands, stmtId, line, raw, state, code);
            case "multiply" -> emitMultiply(operands, stmtId, line, raw, state, code);
            case "divide" -> emitDivide(operands, stmtId, line, raw, state, code);
            case "if" -> emitIf(operands, stmtId, line, raw, state, code);
            case "else" -> emitElse(stmtId, line, raw, state, code);
            case "end_if" -> emitEndBlock("if", stmtId, line, raw, state, code);
            case "evaluate" -> emitEvaluate(operands, stmtId, line, raw, state, code);
            case "when" -> emitWhen(operands, stmtId, line, raw, state, code);
            case "end_evaluate" -> emitEndEvaluate(stmtId, line, raw, state, code);
            case "perform" -> emitPerform(operands, stmtId, line, raw, state, code);
            case "end_perform" -> emitEndPerform(stmtId, line, raw, state, code);
            case "stop" -> {
                code.add("// stop [" + stmtId + " line " + line + "] " + escapeComment(raw));
                code.add("return;");
                state.emittedStatementIds.add(stmtId);
            }
            default -> emitUnsupported(operation, operands, stmtId, line, raw, state, code);
        }
    }

    private static void emitDisplay(Map<String, Object> operands, String stmtId, int line,
                                    String raw, EmissionState state, CodeBuilder code) {
        List<Object> items = listOrEmpty(operands.get("items"));
        code.add("// display [" + stmtId + " line " + line + "] " + escapeComment(raw));
        if (items.isEmpty()) {
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN", "DISPLAY statement had no operands.items"));
            state.diagnostics.add(IrValidator.diagnostic("info", line, "display-no-items",
                    "DISPLAY had no operands.items (" + stmtId + ")"));
            state.emittedStatementIds.add(stmtId);
            return;
        }
        StringBuilder expr = new StringBuilder("System.out.println(new StringBuilder()");
        boolean any = false;
        for (Object token : items) {
            String text = token == null ? "" : token.toString().trim();
            if (text.isEmpty()) {
                continue;
            }
            expr.append(".append(").append(renderDisplayFragment(text, state, line, stmtId)).append(")");
            any = true;
        }
        if (any) {
            expr.append(".toString());");
            code.add(expr.toString());
        } else {
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN", "DISPLAY items contained no non-empty tokens"));
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static String renderDisplayFragment(String token, EmissionState state, int line, String stmtId) {
        if (isQuoted(token)) {
            return javaStringLiteral(unquote(token));
        }
        FieldReference field = fieldReference(token, state, line, stmtId);
        if (field != null) {
            return field.accessor() + ".displayValue()";
        }
        if (isNumericLiteral(token)) {
            return javaStringLiteral(token);
        }
        state.diagnostics.add(IrValidator.diagnostic("info", line, "display-unknown-token",
                "DISPLAY token '" + token + "' is not a declared field (" + stmtId + ")"));
        return javaStringLiteral(token);
    }

    private static void emitMove(Map<String, Object> operands, String stmtId, int line,
                                 String raw, EmissionState state, CodeBuilder code) {
        String source = string(operands.get("source"), "").trim();
        List<Object> targets = listOrEmpty(operands.get("targets"));
        code.add("// move [" + stmtId + " line " + line + "] " + escapeComment(raw));
        if (source.isEmpty() || targets.isEmpty()) {
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN",
                    "MOVE statement missing source/targets in IR operands"));
            state.diagnostics.add(IrValidator.diagnostic("info", line, "move-incomplete",
                    "MOVE missing operands.source or operands.targets (" + stmtId + ")"));
            state.emittedStatementIds.add(stmtId);
            return;
        }

        for (Object targetObject : targets) {
            String targetName = targetObject == null ? "" : targetObject.toString().trim();
            FieldReference target = fieldReference(targetName, state, line, stmtId);
            if (target == null) {
                continue;
            }
            if (isQuoted(source)) {
                code.add(target.accessor() + ".moveLiteral(" + javaStringLiteral(unquote(source)) + ");");
            } else if (isNumericLiteral(source)) {
                code.add(target.accessor() + ".setNumericValue(" + decimalLiteral(source) + ");");
            } else {
                FieldReference sourceField = fieldReference(source, state, line, stmtId);
                if (sourceField == null) {
                    state.diagnostics.add(IrValidator.diagnostic("info", line, "move-unknown-source",
                            "MOVE source '" + source + "' is not a declared field (" + stmtId + ")"));
                    code.add(assumptionRecordCall(stmtId, stmtId, "WARN",
                            "MOVE source not declared as field: " + source));
                } else {
                    code.add(target.accessor() + ".moveFrom(" + sourceField.accessor() + ");");
                }
            }
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitCompute(Map<String, Object> operands, String stmtId, int line,
                                    String raw, EmissionState state, CodeBuilder code) {
        String targetName = string(operands.get("target"), "");
        String expression = string(operands.get("expression"), "");
        code.add("// compute [" + stmtId + " line " + line + "] " + escapeComment(raw));
        FieldReference target = fieldReference(targetName, state, line, stmtId);
        if (target == null || expression.isBlank()) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "compute-incomplete",
                    "COMPUTE missing target or expression (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN",
                    "COMPUTE statement missing target/expression in IR operands"));
        } else {
            code.add(target.accessor() + ".setNumericValue(" + numericExpression(expression, state, line, stmtId) + ");");
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitAdd(Map<String, Object> operands, String stmtId, int line,
                                String raw, EmissionState state, CodeBuilder code) {
        code.add("// add [" + stmtId + " line " + line + "] " + escapeComment(raw));
        List<String> sources = operandStrings(operands, "sources", "source");
        List<String> targets = operandStrings(operands, "targets", "target");
        if (sources.isEmpty() || targets.isEmpty()) {
            sources = addSourcesFromTokens(operands);
            targets = addTargetsFromTokens(operands);
        }
        emitAccumulatorArithmetic("add", sources, targets, stmtId, line, state, code);
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitSubtract(Map<String, Object> operands, String stmtId, int line,
                                     String raw, EmissionState state, CodeBuilder code) {
        code.add("// subtract [" + stmtId + " line " + line + "] " + escapeComment(raw));
        List<String> sources = operandStrings(operands, "sources", "source");
        List<String> targets = operandStrings(operands, "targets", "target");
        if (sources.isEmpty() || targets.isEmpty()) {
            List<String> tokens = tokenStrings(operands.get("tokens"));
            int from = tokens.indexOf("FROM");
            if (from > 1 && from + 1 < tokens.size()) {
                sources = tokens.subList(1, from);
                targets = tokens.subList(from + 1, tokens.size());
            }
        }
        emitAccumulatorArithmetic("subtract", sources, targets, stmtId, line, state, code);
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitAccumulatorArithmetic(String method, List<String> sources, List<String> targets,
                                                  String stmtId, int line, EmissionState state, CodeBuilder code) {
        if (sources.isEmpty() || targets.isEmpty()) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, method + "-incomplete",
                    method.toUpperCase(Locale.ROOT) + " missing sources or targets (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN",
                    method.toUpperCase(Locale.ROOT) + " statement missing sources/targets in IR operands"));
            return;
        }
        for (String targetName : targets) {
            FieldReference target = fieldReference(targetName, state, line, stmtId);
            if (target == null) {
                continue;
            }
            StringBuilder expr = new StringBuilder(target.accessor()).append(".numericValue()");
            for (String source : sources) {
                expr.append(".").append(method).append("(")
                        .append(numericExpression(source, state, line, stmtId)).append(")");
            }
            code.add(target.accessor() + ".setNumericValue(" + expr + ");");
        }
    }

    private static void emitMultiply(Map<String, Object> operands, String stmtId, int line,
                                     String raw, EmissionState state, CodeBuilder code) {
        code.add("// multiply [" + stmtId + " line " + line + "] " + escapeComment(raw));
        String source = string(operands.get("source"), "");
        String by = string(operands.get("by"), "");
        String targetName = string(operands.get("target"), by);
        FieldReference target = fieldReference(targetName, state, line, stmtId);
        if (source.isBlank() || by.isBlank() || target == null) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "multiply-incomplete",
                    "MULTIPLY missing source/by/target (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN",
                    "MULTIPLY statement missing source/by/target in IR operands"));
        } else {
            String expr = numericExpression(by, state, line, stmtId) + ".multiply("
                    + numericExpression(source, state, line, stmtId) + ")";
            code.add(target.accessor() + ".setNumericValue(" + expr + ");");
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitDivide(Map<String, Object> operands, String stmtId, int line,
                                   String raw, EmissionState state, CodeBuilder code) {
        code.add("// divide [" + stmtId + " line " + line + "] " + escapeComment(raw));
        String dividend = string(operands.get("dividend"), "");
        String divisor = string(operands.get("divisor"), "");
        String targetName = string(operands.get("target"), dividend);
        FieldReference target = fieldReference(targetName, state, line, stmtId);
        if (dividend.isBlank() || divisor.isBlank() || target == null) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "divide-incomplete",
                    "DIVIDE missing dividend/divisor/target (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN",
                    "DIVIDE statement missing dividend/divisor/target in IR operands"));
        } else {
            code.add(target.accessor() + ".setNumericValue(" + numericExpression(dividend, state, line, stmtId)
                    + ".divide(" + numericExpression(divisor, state, line, stmtId) + "));");
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitIf(Map<String, Object> operands, String stmtId, int line,
                               String raw, EmissionState state, CodeBuilder code) {
        String condition = string(operands.get("condition"), "");
        code.add("// if [" + stmtId + " line " + line + "] " + escapeComment(raw));
        code.add("if (" + conditionExpression(condition, state, line, stmtId) + ") {");
        code.indent();
        state.frames.push(new BlockFrame("if", stmtId, null));
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitElse(String stmtId, int line, String raw, EmissionState state, CodeBuilder code) {
        code.add("// else [" + stmtId + " line " + line + "] " + escapeComment(raw));
        BlockFrame frame = state.frames.peek();
        if (frame == null || !"if".equals(frame.kind)) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "else-without-if",
                    "ELSE without active IF block (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN", "ELSE without active IF block"));
        } else {
            code.outdent();
            code.add("} else {");
            code.indent();
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitEndBlock(String kind, String stmtId, int line, String raw,
                                     EmissionState state, CodeBuilder code) {
        code.add("// end_" + kind + " [" + stmtId + " line " + line + "] " + escapeComment(raw));
        BlockFrame frame = state.frames.peek();
        if (frame == null || !kind.equals(frame.kind)) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "block-end-mismatch",
                    "END_" + kind.toUpperCase(Locale.ROOT) + " without matching block (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN", "Block end without matching start: " + kind));
        } else {
            state.frames.pop();
            code.outdent();
            code.add("}");
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitEvaluate(Map<String, Object> operands, String stmtId, int line,
                                     String raw, EmissionState state, CodeBuilder code) {
        String selector = string(operands.get("selector"), "");
        code.add("// evaluate [" + stmtId + " line " + line + "] " + escapeComment(raw));
        state.frames.push(new BlockFrame("evaluate", stmtId, selector));
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitWhen(Map<String, Object> operands, String stmtId, int line,
                                 String raw, EmissionState state, CodeBuilder code) {
        String value = string(operands.get("value"), "");
        code.add("// when [" + stmtId + " line " + line + "] " + escapeComment(raw));
        BlockFrame frame = state.frames.peek();
        if (frame == null || !"evaluate".equals(frame.kind)) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "when-without-evaluate",
                    "WHEN without active EVALUATE block (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN", "WHEN without active EVALUATE block"));
        } else {
            if (frame.whenOpen) {
                code.outdent();
                code.add(whenOther(value) ? "} else {" : "} else if (" + evaluateCondition(frame.selector, value, state, line, stmtId) + ") {");
            } else {
                code.add(whenOther(value) ? "if (true) {" : "if (" + evaluateCondition(frame.selector, value, state, line, stmtId) + ") {");
                frame.whenOpen = true;
            }
            code.indent();
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitEndEvaluate(String stmtId, int line, String raw, EmissionState state, CodeBuilder code) {
        code.add("// end_evaluate [" + stmtId + " line " + line + "] " + escapeComment(raw));
        BlockFrame frame = state.frames.peek();
        if (frame == null || !"evaluate".equals(frame.kind)) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "end-evaluate-without-evaluate",
                    "END_EVALUATE without active EVALUATE block (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN", "END_EVALUATE without active EVALUATE block"));
        } else {
            state.frames.pop();
            if (frame.whenOpen) {
                code.outdent();
                code.add("}");
            }
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitPerform(Map<String, Object> operands, String stmtId, int line,
                                    String raw, EmissionState state, CodeBuilder code) {
        PerformSpec perform = performSpec(operands);
        code.add("// perform [" + stmtId + " line " + line + "] " + escapeComment(raw));
        if (perform.varying() != null) {
            FieldReference varying = fieldReference(perform.varying(), state, line, stmtId);
            if (varying != null) {
                code.add(varying.accessor() + ".setNumericValue(" + numericExpression(perform.from(), state, line, stmtId) + ");");
            }
        }
        String guard = "loopGuard_" + javaIdentifier(stmtId);
        code.add("int " + guard + " = 0;");
        code.add("while (!(" + conditionExpression(perform.until(), state, line, stmtId) + ")) {");
        code.indent();
        code.add("if (++" + guard + " > " + LOOP_GUARD_LIMIT + ") {");
        code.indent();
        code.add("throw new IllegalStateException(" + javaStringLiteral("PERFORM loop guard exceeded for " + stmtId) + ");");
        code.outdent();
        code.add("}");
        String increment = null;
        if (perform.varying() != null) {
            FieldReference varying = fieldReference(perform.varying(), state, line, stmtId);
            if (varying != null) {
                increment = varying.accessor() + ".setNumericValue(" + varying.accessor()
                        + ".numericValue().add(" + numericExpression(perform.by(), state, line, stmtId) + "));";
            }
        }
        state.frames.push(new BlockFrame("perform", stmtId, increment));
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitEndPerform(String stmtId, int line, String raw, EmissionState state, CodeBuilder code) {
        code.add("// end_perform [" + stmtId + " line " + line + "] " + escapeComment(raw));
        BlockFrame frame = state.frames.peek();
        if (frame == null || !"perform".equals(frame.kind)) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "end-perform-without-perform",
                    "END_PERFORM without active PERFORM block (" + stmtId + ")"));
            code.add(assumptionRecordCall(stmtId, stmtId, "WARN", "END_PERFORM without active PERFORM block"));
        } else {
            state.frames.pop();
            if (frame.incrementLine != null) {
                code.add(frame.incrementLine);
            }
            code.outdent();
            code.add("}");
        }
        state.emittedStatementIds.add(stmtId);
    }

    private static void emitUnsupported(String operation, Map<String, Object> operands, String stmtId, int line,
                                        String raw, EmissionState state, CodeBuilder code) {
        String description = "W0 generator does not translate '" + operation
                + "' deterministically; recorded as open assumption";
        state.diagnostics.add(IrValidator.diagnostic("info", line, "unsupported-statement",
                description + " (" + stmtId + "): " + raw));
        code.add("// " + operation + " [" + stmtId + " line " + line + "] " + escapeComment(raw));
        code.add(assumptionRecordCall(stmtId, stmtId, "WARN", description));
        state.emittedStatementIds.add(stmtId);
    }

    private static void closeOpenBlocks(EmissionState state, CodeBuilder code) {
        while (!state.frames.isEmpty()) {
            BlockFrame frame = state.frames.pop();
            state.diagnostics.add(IrValidator.diagnostic("info", 0, "unclosed-block",
                    "Generated code closed unmatched IR block " + frame.kind + " (" + frame.stmtId + ")"));
            if ("evaluate".equals(frame.kind) && !frame.whenOpen) {
                continue;
            }
            code.outdent();
            code.add("}");
        }
    }

    private static String numericExpression(String expression, EmissionState state, int line, String stmtId) {
        return new ExpressionParser(tokenizeExpression(expression), state, line, stmtId).parse();
    }

    private static String conditionExpression(String condition, EmissionState state, int line, String stmtId) {
        String text = condition == null ? "" : condition.trim();
        if (text.isBlank()) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "condition-missing",
                    "Condition missing in IR operands (" + stmtId + ")"));
            return "false";
        }
        for (String operator : List.of(">=", "<=", "<>", ">", "<", "=")) {
            int idx = indexOfOperator(text, operator);
            if (idx >= 0) {
                String left = text.substring(0, idx).trim();
                String right = text.substring(idx + operator.length()).trim();
                return relationalExpression(left, operator, right, state, line, stmtId);
            }
        }
        state.diagnostics.add(IrValidator.diagnostic("info", line, "condition-unsupported",
                "Condition has no supported relational operator (" + stmtId + "): " + text));
        return "false";
    }

    private static String relationalExpression(String left, String operator, String right,
                                               EmissionState state, int line, String stmtId) {
        if (isNumericComparable(left, state) && isNumericComparable(right, state)) {
            String method = switch (operator) {
                case "=" -> "equalTo";
                case "<>" -> "notEqual";
                case ">" -> "greaterThan";
                case "<" -> "lessThan";
                case ">=" -> "greaterOrEqual";
                case "<=" -> "lessOrEqual";
                default -> "equalTo";
            };
            return "ConditionStatus." + method + "(" + numericExpression(left, state, line, stmtId)
                    + ", " + numericExpression(right, state, line, stmtId) + ")";
        }
        String leftText = displayTextExpression(left, state, line, stmtId);
        String rightText = displayTextExpression(right, state, line, stmtId);
        if ("=".equals(operator)) {
            return leftText + ".equals(" + rightText + ")";
        }
        if ("<>".equals(operator)) {
            return "!" + leftText + ".equals(" + rightText + ")";
        }
        state.diagnostics.add(IrValidator.diagnostic("info", line, "condition-nonnumeric-relational",
                "Non-numeric relational condition requires equality operator (" + stmtId + ")"));
        return "false";
    }

    private static String evaluateCondition(String selector, String value, EmissionState state, int line, String stmtId) {
        if (isNumericComparable(selector, state) && isNumericComparable(value, state)) {
            return relationalExpression(selector, "=", value, state, line, stmtId);
        }
        return displayTextExpression(selector, state, line, stmtId) + ".equals("
                + displayTextExpression(value, state, line, stmtId) + ")";
    }

    private static String displayTextExpression(String token, EmissionState state, int line, String stmtId) {
        String text = token == null ? "" : token.trim();
        if (isQuoted(text)) {
            return javaStringLiteral(unquote(text));
        }
        FieldReference ref = fieldReference(text, state, line, stmtId);
        if (ref != null) {
            return ref.accessor() + ".displayValue().trim()";
        }
        return javaStringLiteral(text);
    }

    private static boolean isNumericComparable(String token, EmissionState state) {
        String text = token == null ? "" : token.trim();
        if (isNumericLiteral(text)) {
            return true;
        }
        if (text.contains("+") || text.contains("-") || text.contains("*") || text.contains("/")) {
            return true;
        }
        String name = referenceName(text);
        FieldEmission field = state.fields.get(name);
        return field != null && field.numeric;
    }

    private static FieldReference fieldReference(String token, EmissionState state, int line, String stmtId) {
        String name = referenceName(token);
        if (name.isBlank()) {
            return null;
        }
        FieldEmission field = state.fields.get(name);
        if (field == null) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "unknown-field-reference",
                    "Field reference '" + token + "' is not declared in IR fieldLayouts (" + stmtId + ")"));
            return null;
        }
        String index = referenceIndex(token);
        if (field.array()) {
            String indexExpr = index == null || index.isBlank() ? "1" : indexExpression(index, state, line, stmtId);
            if (index == null || index.isBlank()) {
                state.diagnostics.add(IrValidator.diagnostic("info", line, "array-reference-missing-index",
                        "Array field reference '" + token + "' has no subscript; emitted index 1 fallback (" + stmtId + ")"));
            }
            return new FieldReference(field, field.fieldVar + ".get(" + indexExpr + ")");
        }
        if (index != null) {
            state.diagnostics.add(IrValidator.diagnostic("info", line, "scalar-reference-has-index",
                    "Scalar field reference '" + token + "' includes a subscript (" + stmtId + ")"));
        }
        return new FieldReference(field, field.fieldVar);
    }

    private static String indexExpression(String index, EmissionState state, int line, String stmtId) {
        String text = index.trim();
        if (isNumericLiteral(text)) {
            return Integer.toString((int) Double.parseDouble(stripLeadingPlus(text)));
        }
        FieldReference ref = fieldReference(text, state, line, stmtId);
        if (ref != null) {
            return ref.accessor() + ".intValueExact()";
        }
        state.diagnostics.add(IrValidator.diagnostic("info", line, "unsupported-array-index",
                "Array subscript '" + index + "' is not a numeric literal or declared field (" + stmtId + ")"));
        return "1";
    }

    private static String referenceName(String token) {
        String text = token == null ? "" : token.trim().toUpperCase(Locale.ROOT);
        int paren = text.indexOf('(');
        if (paren >= 0) {
            text = text.substring(0, paren).trim();
        }
        return text;
    }

    private static String referenceIndex(String token) {
        String text = token == null ? "" : token.trim();
        int open = text.indexOf('(');
        int close = text.lastIndexOf(')');
        if (open >= 0 && close > open) {
            return text.substring(open + 1, close).trim();
        }
        return null;
    }

    private static PerformSpec performSpec(Map<String, Object> operands) {
        String mode = string(operands.get("mode"), "");
        if ("until".equals(mode)) {
            return new PerformSpec(null, null, null, string(operands.get("until"), ""));
        }
        if ("varying-until".equals(mode)) {
            return new PerformSpec(string(operands.get("varying"), null),
                    string(operands.get("from"), "0"),
                    string(operands.get("by"), "1"),
                    string(operands.get("until"), ""));
        }
        List<String> tokens = tokenStrings(operands.get("tokens"));
        if (tokens.size() >= 3 && "UNTIL".equals(tokens.get(1))) {
            return new PerformSpec(null, null, null, String.join(" ", tokens.subList(2, tokens.size())));
        }
        int from = tokens.indexOf("FROM");
        int by = tokens.indexOf("BY");
        int until = tokens.indexOf("UNTIL");
        if (tokens.size() >= 8 && "VARYING".equals(tokens.get(1)) && from == 3 && by > from && until > by) {
            return new PerformSpec(tokens.get(2), tokens.get(from + 1), tokens.get(by + 1),
                    String.join(" ", tokens.subList(until + 1, tokens.size())));
        }
        return new PerformSpec(null, null, null, "false");
    }

    private static List<String> addSourcesFromTokens(Map<String, Object> operands) {
        List<String> tokens = tokenStrings(operands.get("tokens"));
        int to = tokens.indexOf("TO");
        return to > 1 ? new ArrayList<>(tokens.subList(1, to)) : List.of();
    }

    private static List<String> addTargetsFromTokens(Map<String, Object> operands) {
        List<String> tokens = tokenStrings(operands.get("tokens"));
        int to = tokens.indexOf("TO");
        return to > 0 && to + 1 < tokens.size() ? new ArrayList<>(tokens.subList(to + 1, tokens.size())) : List.of();
    }

    private static List<String> operandStrings(Map<String, Object> operands, String pluralKey, String singleKey) {
        List<String> values = tokenStrings(operands.get(pluralKey));
        if (!values.isEmpty()) {
            return values;
        }
        String single = string(operands.get(singleKey), "");
        return single.isBlank() ? List.of() : List.of(single);
    }

    private static String renderJavaClass(String packageName, String className, String programId,
                                          String irId, String sourceHash,
                                          Iterable<FieldEmission> fields, List<String> runBody,
                                          List<String> assumptionRecords) {
        StringBuilder sb = new StringBuilder(4096);
        sb.append("package ").append(packageName).append(";\n\n");
        sb.append("import com.c2c.target.java.runtime.AssumptionRegistry;\n");
        sb.append("import com.c2c.target.java.runtime.AssumptionRegistry.Severity;\n");
        sb.append("import com.c2c.target.java.runtime.CobolDecimal;\n");
        sb.append("import com.c2c.target.java.runtime.CobolField;\n");
        sb.append("import com.c2c.target.java.runtime.CobolFieldArray;\n");
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
            sb.append("    private final ").append(field.array() ? "CobolFieldArray " : "CobolField ")
                    .append(field.fieldVar).append(";\n");
        }
        sb.append('\n');
        sb.append("    public ").append(className).append("() {\n");
        for (FieldEmission field : fields) {
            sb.append("        this.").append(field.fieldVar);
            if (field.array()) {
                sb.append(" = new CobolFieldArray(\"").append(escapeJavaString(field.cobolName))
                        .append("\", \"").append(escapeJavaString(field.irNodeId))
                        .append("\", PictureSpec.parse(\"").append(escapeJavaString(field.picture))
                        .append("\"), ").append(field.occurs).append(");\n");
            } else {
                sb.append(" = new CobolField(\"").append(escapeJavaString(field.cobolName))
                        .append("\", \"").append(escapeJavaString(field.irNodeId))
                        .append("\", PictureSpec.parse(\"").append(escapeJavaString(field.picture))
                        .append("\"));\n");
            }
        }
        for (FieldEmission field : fields) {
            String initialValue = normalizeInitialValue(field.initialValue);
            if (initialValue == null) {
                continue;
            }
            if (field.numeric) {
                if (field.array()) {
                    sb.append("        this.").append(field.fieldVar).append(".setNumericValueToAll(")
                            .append(decimalLiteral(initialValue)).append(");\n");
                } else {
                    sb.append("        this.").append(field.fieldVar).append(".setNumericValue(")
                            .append(decimalLiteral(initialValue)).append(");\n");
                }
            } else {
                String literal = alphanumericInitialValue(initialValue);
                if (field.array()) {
                    sb.append("        this.").append(field.fieldVar).append(".moveLiteralToAll(")
                            .append(javaStringLiteral(literal)).append(");\n");
                } else {
                    sb.append("        this.").append(field.fieldVar).append(".moveLiteral(")
                            .append(javaStringLiteral(literal)).append(");\n");
                }
            }
        }
        for (String record : assumptionRecords) {
            sb.append("        ").append(record).append('\n');
        }
        sb.append("    }\n\n");
        sb.append("    public AssumptionRegistry assumptions() {\n");
        sb.append("        return assumptionRegistry;\n");
        sb.append("    }\n\n");
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
            if (c == '-' || c == '_' || c == '[' || c == ']') {
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

    private static int indexOfOperator(String condition, String operator) {
        boolean quoted = false;
        int depth = 0;
        for (int i = 0; i <= condition.length() - operator.length(); i++) {
            char ch = condition.charAt(i);
            if (ch == '"') {
                quoted = !quoted;
            } else if (!quoted && ch == '(') {
                depth++;
            } else if (!quoted && ch == ')' && depth > 0) {
                depth--;
            }
            if (!quoted && depth == 0 && condition.startsWith(operator, i)) {
                return i;
            }
        }
        return -1;
    }

    private static List<String> tokenizeExpression(String value) {
        List<String> tokens = new ArrayList<>();
        if (value == null || value.isBlank()) {
            return tokens;
        }
        int i = 0;
        String previous = null;
        while (i < value.length()) {
            while (i < value.length() && Character.isWhitespace(value.charAt(i))) {
                i++;
            }
            if (i >= value.length()) {
                break;
            }
            char ch = value.charAt(i);
            boolean unarySign = (ch == '+' || ch == '-')
                    && i + 1 < value.length()
                    && (Character.isDigit(value.charAt(i + 1)) || value.charAt(i + 1) == '.')
                    && (previous == null || "+-*/(".contains(previous));
            if (Character.isDigit(ch) || ch == '.' || unarySign) {
                int start = i++;
                while (i < value.length() && (Character.isDigit(value.charAt(i)) || value.charAt(i) == '.')) {
                    i++;
                }
                previous = value.substring(start, i);
                tokens.add(previous);
                continue;
            }
            if (Character.isLetter(ch)) {
                int start = i++;
                while (i < value.length()) {
                    char c = value.charAt(i);
                    if (Character.isLetterOrDigit(c) || c == '-') {
                        i++;
                    } else {
                        break;
                    }
                }
                String name = value.substring(start, i).toUpperCase(Locale.ROOT);
                int lookahead = i;
                while (lookahead < value.length() && Character.isWhitespace(value.charAt(lookahead))) {
                    lookahead++;
                }
                if (lookahead < value.length() && value.charAt(lookahead) == '(') {
                    int end = matchingParen(value, lookahead);
                    if (end > lookahead) {
                        name = name + " " + value.substring(lookahead, end + 1).trim().toUpperCase(Locale.ROOT);
                        i = end + 1;
                    }
                }
                previous = name;
                tokens.add(name);
                continue;
            }
            if ("+-*/()".indexOf(ch) >= 0) {
                previous = String.valueOf(ch);
                tokens.add(previous);
                i++;
                continue;
            }
            tokens.add(String.valueOf(ch));
            previous = String.valueOf(ch);
            i++;
        }
        return tokens;
    }

    private static int matchingParen(String value, int open) {
        int depth = 0;
        for (int i = open; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (ch == '(') {
                depth++;
            } else if (ch == ')') {
                depth--;
                if (depth == 0) {
                    return i;
                }
            }
        }
        return -1;
    }

    private static String decimalLiteral(String literal) {
        String normalized = stripLeadingPlus(literal.trim());
        int scale = 0;
        int dot = normalized.indexOf('.');
        if (dot >= 0) {
            scale = normalized.length() - dot - 1;
        }
        boolean signed = normalized.startsWith("-");
        return "CobolDecimal.of(" + javaStringLiteral(normalized) + ", " + scale + ", " + signed + ")";
    }

    private static String stripLeadingPlus(String value) {
        return value != null && value.startsWith("+") ? value.substring(1) : value;
    }

    private static boolean isNumericLiteral(String token) {
        return token != null && token.trim().matches("[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)");
    }

    private static boolean isQuoted(String token) {
        return token != null && token.length() >= 2 && token.startsWith("\"") && token.endsWith("\"");
    }

    private static boolean whenOther(String value) {
        return "OTHER".equalsIgnoreCase(value == null ? "" : value.trim());
    }

    private static String normalizeInitialValue(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String value = raw.trim();
        if (value.endsWith(".")) {
            value = value.substring(0, value.length() - 1).trim();
        }
        if ("ZERO".equalsIgnoreCase(value) || "ZEROS".equalsIgnoreCase(value) || "ZEROES".equalsIgnoreCase(value)) {
            return "0";
        }
        if ("SPACE".equalsIgnoreCase(value) || "SPACES".equalsIgnoreCase(value)) {
            return " ";
        }
        return isQuoted(value) ? unquote(value) : value;
    }

    private static String alphanumericInitialValue(String value) {
        if (value == null) {
            return "";
        }
        if ("SPACE".equalsIgnoreCase(value) || "SPACES".equalsIgnoreCase(value)) {
            return " ";
        }
        return value;
    }

    private static String unquote(String token) {
        return isQuoted(token) ? token.substring(1, token.length() - 1) : token;
    }

    private static String javaStringLiteral(String value) {
        return "\"" + escapeJavaString(value == null ? "" : value) + "\"";
    }

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
        return raw.replace("\\", "/").replace("*/", "* /").replace("\n", " ").replace("\r", " ");
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

    private static List<String> tokenStrings(Object value) {
        List<String> result = new ArrayList<>();
        for (Object item : listOrEmpty(value)) {
            if (item != null) {
                result.add(item.toString().trim());
            }
        }
        return result;
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
        return intValue(value, 0);
    }

    private static int intValue(Object value, int fallback) {
        Integer i = integerOrNull(value);
        return i == null ? fallback : i;
    }

    private static boolean booleanValue(Object value, boolean fallback) {
        return value instanceof Boolean b ? b : fallback;
    }

    private static final class EmissionState {
        final Map<String, FieldEmission> fields;
        final List<Map<String, Object>> diagnostics;
        final List<String> assumptionRecords;
        final List<String> emittedStatementIds;
        final Deque<BlockFrame> frames = new ArrayDeque<>();

        EmissionState(Map<String, FieldEmission> fields,
                      List<Map<String, Object>> diagnostics,
                      List<String> assumptionRecords,
                      List<String> emittedStatementIds) {
            this.fields = fields;
            this.diagnostics = diagnostics;
            this.assumptionRecords = assumptionRecords;
            this.emittedStatementIds = emittedStatementIds;
        }
    }

    private static final class CodeBuilder {
        private final List<String> lines;
        private int indent = 2;

        CodeBuilder(List<String> lines) {
            this.lines = lines;
        }

        void add(String code) {
            lines.add("    ".repeat(Math.max(0, indent)) + code);
        }

        void indent() {
            indent++;
        }

        void outdent() {
            indent = Math.max(2, indent - 1);
        }
    }

    private static final class BlockFrame {
        final String kind;
        final String stmtId;
        final String selector;
        final String incrementLine;
        boolean whenOpen;

        BlockFrame(String kind, String stmtId, String selectorOrIncrement) {
            this.kind = kind;
            this.stmtId = stmtId;
            if ("perform".equals(kind)) {
                this.selector = null;
                this.incrementLine = selectorOrIncrement;
            } else {
                this.selector = selectorOrIncrement;
                this.incrementLine = null;
            }
        }
    }

    private static final class ExpressionParser {
        private final List<String> tokens;
        private final EmissionState state;
        private final int line;
        private final String stmtId;
        private int pos;

        ExpressionParser(List<String> tokens, EmissionState state, int line, String stmtId) {
            this.tokens = tokens;
            this.state = state;
            this.line = line;
            this.stmtId = stmtId;
        }

        String parse() {
            if (tokens.isEmpty()) {
                state.diagnostics.add(IrValidator.diagnostic("info", line, "numeric-expression-empty",
                        "Numeric expression is empty (" + stmtId + ")"));
                return "CobolDecimal.of(0L, 0, false)";
            }
            String expression = parseAddSub();
            if (pos < tokens.size()) {
                state.diagnostics.add(IrValidator.diagnostic("info", line, "numeric-expression-trailing-token",
                        "Numeric expression has trailing token '" + tokens.get(pos) + "' (" + stmtId + ")"));
            }
            return expression;
        }

        private String parseAddSub() {
            StringBuilder left = new StringBuilder(parseMulDiv());
            while (pos < tokens.size()) {
                String op = tokens.get(pos);
                if (!"+".equals(op) && !"-".equals(op)) {
                    break;
                }
                pos++;
                String right = parseMulDiv();
                left.append("+".equals(op) ? ".add(" : ".subtract(").append(right).append(")");
            }
            return left.toString();
        }

        private String parseMulDiv() {
            StringBuilder left = new StringBuilder(parseFactor());
            while (pos < tokens.size()) {
                String op = tokens.get(pos);
                if (!"*".equals(op) && !"/".equals(op)) {
                    break;
                }
                pos++;
                String right = parseFactor();
                left.append("*".equals(op) ? ".multiply(" : ".divide(").append(right).append(")");
            }
            return left.toString();
        }

        private String parseFactor() {
            if (pos >= tokens.size()) {
                state.diagnostics.add(IrValidator.diagnostic("info", line, "numeric-expression-missing-factor",
                        "Numeric expression ended before a factor (" + stmtId + ")"));
                return "CobolDecimal.of(0L, 0, false)";
            }
            String token = tokens.get(pos++);
            if ("(".equals(token)) {
                String nested = parseAddSub();
                if (pos < tokens.size() && ")".equals(tokens.get(pos))) {
                    pos++;
                }
                return nested;
            }
            if (isNumericLiteral(token)) {
                return decimalLiteral(token);
            }
            FieldReference field = fieldReference(token, state, line, stmtId);
            if (field != null) {
                return field.accessor() + ".numericValue()";
            }
            state.diagnostics.add(IrValidator.diagnostic("info", line, "numeric-expression-unknown-token",
                    "Numeric expression token '" + token + "' is unsupported (" + stmtId + ")"));
            return "CobolDecimal.of(0L, 0, false)";
        }
    }

    record FieldEmission(String fieldVar, String cobolName, String irNodeId, String picture,
                         int occurs, boolean numeric, String initialValue) {
        boolean array() {
            return occurs > 1;
        }
    }

    record FieldReference(FieldEmission field, String accessor) {
    }

    record PerformSpec(String varying, String from, String by, String until) {
    }

    record GenerationResult(Map<String, String> files,
                            List<Map<String, Object>> diagnostics,
                            Map<String, Object> traceability,
                            String entryClass,
                            String entryFilePath) {
    }
}
