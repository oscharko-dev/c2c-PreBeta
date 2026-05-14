package com.c2c.w0.buildtest;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Reproduces registry entries marked as true Golden Masters with GnuCOBOL, and
 * — for Issue #92 — compiles and executes arbitrary UI-provided COBOL source
 * to produce an executable oracle for stdout comparison.
 * <p>
 * Registry reproduction restricts COBOL source paths to the repository
 * corpus directory. Inline source from a build-test request is written to an
 * isolated temp directory and executed there with the COBOL toolchain.
 */
final class CobolRuntimeExecutor {

    private static final long DEFAULT_TIMEOUT_MS = Duration.ofSeconds(10).toMillis();
    private static final int MAX_SOURCE_BYTES = 1_048_576;
    private static final Pattern PROGRAM_ID_PATTERN =
            Pattern.compile("(?im)^\\s*PROGRAM-ID\\s*\\.\\s*([A-Za-z][A-Za-z0-9_-]{0,62})\\s*\\.");
    private static final Pattern MODULE_NAME_PATTERN =
            Pattern.compile("[A-Za-z][A-Za-z0-9_-]{0,62}");

    private CobolRuntimeExecutor() {
    }

    static boolean isAvailable() {
        return versionOf(cobcCommand()).exitCode() == 0 && versionOf(cobcrunCommand()).exitCode() == 0;
    }

    static Reproduction reproduce(GoldenMaster.Resolved golden, Path repoRoot, long timeoutMs) {
        long effectiveTimeoutMs = timeoutMs <= 0 ? DEFAULT_TIMEOUT_MS : timeoutMs;
        if (golden == null || !golden.isTrueFixture()) {
            return Reproduction.notAttempted("fixture is not classified as a true Golden Master");
        }

        String cobcCommand = cobcCommand();
        String cobcrunCommand = cobcrunCommand();
        VersionResult cobcVersion = versionOf(cobcCommand);
        VersionResult cobcrunVersion = versionOf(cobcrunCommand);
        if (cobcVersion.exitCode() != 0 || cobcrunVersion.exitCode() != 0) {
            return Reproduction.unavailable(cobcVersion.firstLine(), cobcrunVersion.firstLine());
        }

        Path workingRoot = null;
        try {
            Path source = resolveCorpusSource(repoRoot, golden.cobolSource());
            String moduleName = moduleName(golden.programId());
            workingRoot = Files.createTempDirectory("c2c-cobol-golden-master-");
            Path modulePath = workingRoot.resolve(moduleFileName(moduleName));

            CommandResult compile = runCommand(List.of(
                    cobcCommand, "-m", "-o", modulePath.toString(), source.toString()),
                    workingRoot, Map.of(), effectiveTimeoutMs);
            if (compile.exitCode() != 0) {
                return Reproduction.compileFailed(golden, moduleName, source, compile,
                        cobcVersion.firstLine(), cobcrunVersion.firstLine());
            }

            Map<String, String> env = Map.of("COB_LIBRARY_PATH", workingRoot.toString());
            CommandResult run = runCommand(List.of(cobcrunCommand, moduleName),
                    workingRoot, env, effectiveTimeoutMs);
            boolean matched = normalise(run.stdout()).equals(normalise(golden.expected()));
            return Reproduction.ran(golden, moduleName, source, compile, run, matched,
                    cobcVersion.firstLine(), cobcrunVersion.firstLine());
        } catch (IllegalArgumentException | IOException e) {
            return Reproduction.failedBeforeCompile(golden, e.getMessage(),
                    cobcVersion.firstLine(), cobcrunVersion.firstLine());
        } finally {
            GeneratedProjectMaterializer.deleteRecursively(workingRoot);
        }
    }

    /**
     * Compile and execute an arbitrary COBOL source text and capture stdout.
     * <p>
     * Used by the build-test runner when a request supplies an
     * {@code oracle.mode = "cobol-runtime"} oracle. The caller is responsible
     * for comparing the captured stdout against generated Java stdout.
     *
     * @param requestedProgramId the program id from the request (used as the
     *                           module name passed to {@code cobcrun}); if
     *                           blank, the {@code PROGRAM-ID} declared in the
     *                           source text is used
     * @param sourceText         the full COBOL source to compile and run
     * @param timeoutMs          per-process wall-clock budget for compile and
     *                           run
     * @return a structured {@link OracleRun} describing availability, compile,
     *         run, stdout, stderr, and diagnostics
     */
    static OracleRun executeSource(String requestedProgramId, String sourceText, long timeoutMs) {
        long effectiveTimeoutMs = timeoutMs <= 0 ? DEFAULT_TIMEOUT_MS : timeoutMs;
        if (sourceText == null || sourceText.isBlank()) {
            return OracleRun.invalidInput("oracle.sourceText is required");
        }
        if (sourceText.getBytes(StandardCharsets.UTF_8).length > MAX_SOURCE_BYTES) {
            return OracleRun.invalidInput(
                    "oracle.sourceText exceeds maximum size of " + MAX_SOURCE_BYTES + " bytes");
        }

        String moduleName;
        try {
            moduleName = resolveModuleName(requestedProgramId, sourceText);
        } catch (IllegalArgumentException e) {
            return OracleRun.invalidInput(e.getMessage());
        }

        String cobcCommand = cobcCommand();
        String cobcrunCommand = cobcrunCommand();
        VersionResult cobcVersion = versionOf(cobcCommand);
        VersionResult cobcrunVersion = versionOf(cobcrunCommand);
        if (cobcVersion.exitCode() != 0 || cobcrunVersion.exitCode() != 0) {
            return OracleRun.unavailable(moduleName, cobcVersion.firstLine(), cobcrunVersion.firstLine());
        }

        Path workingRoot = null;
        try {
            workingRoot = Files.createTempDirectory("c2c-cobol-oracle-");
            Path source = workingRoot.resolve(moduleName + ".cbl");
            Files.writeString(source, sourceText, StandardCharsets.UTF_8);
            Path modulePath = workingRoot.resolve(moduleFileName(moduleName));

            List<String> compileArgs = oracleCompileCommand(cobcCommand, sourceText,
                    modulePath, source);
            CommandResult compile = runCommand(compileArgs,
                    workingRoot, Map.of(), effectiveTimeoutMs);
            if (compile.exitCode() != 0) {
                return OracleRun.compileFailed(moduleName, compile,
                        cobcVersion.firstLine(), cobcrunVersion.firstLine());
            }

            Map<String, String> env = Map.of("COB_LIBRARY_PATH", workingRoot.toString());
            CommandResult run = runCommand(List.of(cobcrunCommand, moduleName),
                    workingRoot, env, effectiveTimeoutMs);
            return OracleRun.ran(moduleName, compile, run,
                    cobcVersion.firstLine(), cobcrunVersion.firstLine());
        } catch (IOException e) {
            return OracleRun.ioError(moduleName, e.getMessage(),
                    cobcVersion.firstLine(), cobcrunVersion.firstLine());
        } finally {
            GeneratedProjectMaterializer.deleteRecursively(workingRoot);
        }
    }

    /**
     * Build the {@code cobc} command line for compiling a UI-supplied oracle.
     * <p>
     * UI-pasted COBOL is rarely strictly column-positioned, and GnuCOBOL's
     * default format heuristics differ between 3.1.x and 3.2.x. Heuristically
     * detect whether the source looks fixed-format (lines indented to column
     * 7 with code starting in area A) and explicitly pass
     * {@code -fsource-format=fixed} or {@code -fsource-format=free}, so the
     * compiler never has to guess.
     */
    static List<String> oracleCompileCommand(String cobcCommand, String sourceText,
                                             Path modulePath, Path source) {
        String formatFlag = looksLikeFixedFormatCobol(sourceText) ? "--fixed" : "--free";
        return List.of(cobcCommand, "-m", formatFlag,
                "-o", modulePath.toString(), source.toString());
    }

    static boolean looksLikeFixedFormatCobol(String sourceText) {
        if (sourceText == null) {
            return false;
        }
        for (String line : sourceText.split("\n", -1)) {
            String trimmed = line.stripTrailing();
            if (trimmed.isEmpty()) {
                continue;
            }
            int leading = countLeadingSpaces(trimmed);
            if (leading >= 6 && trimmed.length() > leading) {
                // Looks like the first six (or seven) columns are reserved
                // for the sequence/indicator area: classic fixed format.
                return true;
            }
            return false;
        }
        return false;
    }

    private static int countLeadingSpaces(String line) {
        int i = 0;
        while (i < line.length() && line.charAt(i) == ' ') {
            i++;
        }
        return i;
    }

    private static String resolveModuleName(String requestedProgramId, String sourceText) {
        String candidate = requestedProgramId == null ? "" : requestedProgramId.trim();
        if (!candidate.isEmpty()) {
            if (!MODULE_NAME_PATTERN.matcher(candidate).matches()) {
                throw new IllegalArgumentException(
                        "oracle programId is not a safe COBOL module name: " + requestedProgramId);
            }
            return candidate;
        }
        Matcher matcher = PROGRAM_ID_PATTERN.matcher(sourceText);
        if (matcher.find()) {
            return matcher.group(1);
        }
        throw new IllegalArgumentException(
                "oracle.sourceText does not declare a PROGRAM-ID and no programId was provided");
    }

    private static Path resolveCorpusSource(Path repoRoot, String relativePath) {
        if (repoRoot == null) {
            throw new IllegalArgumentException("repo root is required for true Golden Master reproduction");
        }
        if (relativePath == null || relativePath.isBlank()) {
            throw new IllegalArgumentException("true Golden Master entry is missing cobolSource");
        }
        if (relativePath.startsWith("/") || relativePath.contains("\\") || relativePath.contains("..")) {
            throw new IllegalArgumentException("COBOL source path is unsafe: " + relativePath);
        }

        Path root = repoRoot.toAbsolutePath().normalize();
        Path source = root.resolve(relativePath).normalize();
        Path corpusRoot = root.resolve("corpus").normalize();
        if (!source.startsWith(corpusRoot)) {
            throw new IllegalArgumentException("COBOL source path must stay inside corpus/: " + relativePath);
        }
        if (!Files.isRegularFile(source)) {
            throw new IllegalArgumentException("COBOL source file is missing: " + relativePath);
        }
        return source;
    }

    private static String moduleName(String programId) {
        String candidate = programId == null ? "" : programId.trim();
        if (!candidate.matches("[A-Za-z][A-Za-z0-9_-]{0,62}")) {
            throw new IllegalArgumentException("COBOL programId is not a safe module name: " + programId);
        }
        return candidate;
    }

    static String moduleFileName(String moduleName) {
        return moduleFileName(moduleName, System.getProperty("os.name", ""));
    }

    static String moduleFileName(String moduleName, String osName) {
        String normalized = osName == null ? "" : osName.toLowerCase();
        if (normalized.contains("mac") || normalized.contains("darwin")) {
            return moduleName + ".dylib";
        }
        if (normalized.contains("win")) {
            return moduleName + ".dll";
        }
        return moduleName + ".so";
    }

    private static VersionResult versionOf(String executable) {
        CommandResult result = runCommand(List.of(executable, "--version"),
                Path.of("").toAbsolutePath(), Map.of(), 2000L);
        return new VersionResult(result.exitCode(), firstLine(result.stdout()), firstLine(result.stderr()));
    }

    private static String cobcCommand() {
        return commandProperty("c2c.cobc.path", "cobc");
    }

    private static String cobcrunCommand() {
        return commandProperty("c2c.cobcrun.path", "cobcrun");
    }

    private static String commandProperty(String key, String fallback) {
        String value = System.getProperty(key);
        return value == null || value.isBlank() ? fallback : value.trim();
    }

    private static String firstLine(String text) {
        if (text == null || text.isBlank()) {
            return "";
        }
        return text.lines().findFirst().orElse("").trim();
    }

    private static CommandResult runCommand(List<String> command, Path workingDirectory,
                                            Map<String, String> environment, long timeoutMs) {
        Instant started = Instant.now();
        try {
            ProcessBuilder builder = new ProcessBuilder(command);
            builder.directory(workingDirectory.toFile());
            builder.environment().putAll(environment);
            Process process = builder.start();
            CompletableFuture<String> stdout = CompletableFuture.supplyAsync(
                    () -> readAll(process.getInputStream()));
            CompletableFuture<String> stderr = CompletableFuture.supplyAsync(
                    () -> readAll(process.getErrorStream()));

            boolean finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroyForcibly();
                process.waitFor(1, TimeUnit.SECONDS);
                long durationMs = Duration.between(started, Instant.now()).toMillis();
                return new CommandResult(-1, valueOf(stdout), valueOf(stderr),
                        durationMs, "timeout after " + timeoutMs + "ms");
            }
            long durationMs = Duration.between(started, Instant.now()).toMillis();
            return new CommandResult(process.exitValue(), valueOf(stdout), valueOf(stderr),
                    durationMs, "");
        } catch (IOException e) {
            long durationMs = Duration.between(started, Instant.now()).toMillis();
            return new CommandResult(-1, "", e.getMessage() == null ? "" : e.getMessage(),
                    durationMs, e.getMessage() == null ? "io-error" : e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            long durationMs = Duration.between(started, Instant.now()).toMillis();
            return new CommandResult(-1, "", "interrupted", durationMs, "interrupted");
        }
    }

    private static String readAll(InputStream stream) {
        try (stream) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    private static String valueOf(CompletableFuture<String> future) {
        try {
            return future.get(1, TimeUnit.SECONDS);
        } catch (Exception e) {
            return "";
        }
    }

    private static String normalise(String value) {
        if (value == null) {
            return "";
        }
        return value.replace("\r\n", "\n").trim();
    }

    record Reproduction(boolean attempted, boolean available, boolean compileOk,
                        boolean ran, boolean ok, boolean matched, int compileExitCode,
                        int exitCode, String stdout, String stderr, String reason,
                        String programId, String cobolSource, String moduleName,
                        String cobcVersion, String cobcrunVersion, long durationMs) {

        static Reproduction notAttempted(String reason) {
            return new Reproduction(false, false, false, false, false, false,
                    -1, -1, "", "", reason, "", "", "", "", "", 0);
        }

        static Reproduction unavailable(String cobcVersion, String cobcrunVersion) {
            return new Reproduction(true, false, false, false, false, false,
                    -1, -1, "", "", "cobc and cobcrun must be available for true Golden Master reproduction",
                    "", "", "", cobcVersion, cobcrunVersion, 0);
        }

        static Reproduction failedBeforeCompile(GoldenMaster.Resolved golden, String reason,
                                                String cobcVersion, String cobcrunVersion) {
            return new Reproduction(true, true, false, false, false, false,
                    -1, -1, "", "", reason,
                    golden.programId(), golden.cobolSource(), "",
                    cobcVersion, cobcrunVersion, 0);
        }

        static Reproduction compileFailed(GoldenMaster.Resolved golden, String moduleName,
                                          Path source, CommandResult compile,
                                          String cobcVersion, String cobcrunVersion) {
            return new Reproduction(true, true, false, false, false, false,
                    compile.exitCode(), -1, "", compile.stderr(), "cobc failed",
                    golden.programId(), relativePath(source), moduleName,
                    cobcVersion, cobcrunVersion, compile.durationMs());
        }

        static Reproduction ran(GoldenMaster.Resolved golden, String moduleName,
                                Path source, CommandResult compile, CommandResult run,
                                boolean matched, String cobcVersion, String cobcrunVersion) {
            boolean runOk = run.exitCode() == 0;
            return new Reproduction(true, true, true, true, runOk && matched, matched,
                    compile.exitCode(), run.exitCode(), run.stdout(), run.stderr(),
                    runOk ? "" : run.reason(), golden.programId(), relativePath(source),
                    moduleName, cobcVersion, cobcrunVersion,
                    compile.durationMs() + run.durationMs());
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("attempted", attempted);
            map.put("available", available);
            map.put("compileOk", compileOk);
            map.put("ran", ran);
            map.put("ok", ok);
            map.put("matched", matched);
            map.put("compileExitCode", compileExitCode);
            map.put("exitCode", exitCode);
            map.put("stdout", stdout == null ? "" : stdout);
            map.put("stderr", stderr == null ? "" : stderr);
            map.put("stdoutSha256", HashUtil.sha256(stdout == null ? "" : stdout));
            map.put("durationMs", durationMs);
            map.put("reason", reason == null ? "" : reason);
            map.put("programId", programId == null ? "" : programId);
            map.put("cobolSource", cobolSource == null ? "" : cobolSource);
            map.put("moduleName", moduleName == null ? "" : moduleName);
            map.put("compiler", "cobc");
            map.put("runtime", "cobcrun");
            map.put("cobcVersion", cobcVersion == null ? "" : cobcVersion);
            map.put("cobcrunVersion", cobcrunVersion == null ? "" : cobcrunVersion);
            return map;
        }

        private static String relativePath(Path source) {
            String path = source == null ? "" : source.toString();
            int marker = path.indexOf("/corpus/");
            return marker >= 0 ? path.substring(marker + 1) : path;
        }
    }

    /**
     * Result of {@link #executeSource(String, String, long)}.
     *
     * <p>{@link #attempted} is {@code false} only when the request is rejected
     * before the toolchain is consulted (e.g. empty source). Otherwise the
     * record always reports the toolchain version strings observed so the
     * caller can include them in diagnostics.
     */
    record OracleRun(boolean attempted, boolean available, boolean compileOk,
                     boolean ran, boolean runOk, int compileExitCode, int exitCode,
                     String stdout, String stderr, long durationMs, String reason,
                     String moduleName, String cobcVersion, String cobcrunVersion) {

        static OracleRun invalidInput(String reason) {
            return new OracleRun(false, false, false, false, false,
                    -1, -1, "", "", 0, reason, "", "", "");
        }

        static OracleRun unavailable(String moduleName, String cobcVersion, String cobcrunVersion) {
            return new OracleRun(true, false, false, false, false,
                    -1, -1, "", "",
                    0,
                    "GnuCOBOL cobc/cobcrun are not available on this host",
                    moduleName, cobcVersion, cobcrunVersion);
        }

        static OracleRun compileFailed(String moduleName, CommandResult compile,
                                       String cobcVersion, String cobcrunVersion) {
            return new OracleRun(true, true, false, false, false,
                    compile.exitCode(), -1, "", compile.stderr(),
                    compile.durationMs(),
                    "cobc failed to compile the oracle source",
                    moduleName, cobcVersion, cobcrunVersion);
        }

        static OracleRun ran(String moduleName, CommandResult compile, CommandResult run,
                             String cobcVersion, String cobcrunVersion) {
            boolean runOk = run.exitCode() == 0;
            String reason = runOk
                    ? ""
                    : (run.reason() == null || run.reason().isBlank()
                            ? "cobcrun exited with code " + run.exitCode()
                            : run.reason());
            return new OracleRun(true, true, true, true, runOk,
                    compile.exitCode(), run.exitCode(),
                    run.stdout() == null ? "" : run.stdout(),
                    run.stderr() == null ? "" : run.stderr(),
                    compile.durationMs() + run.durationMs(),
                    reason, moduleName, cobcVersion, cobcrunVersion);
        }

        static OracleRun ioError(String moduleName, String message,
                                 String cobcVersion, String cobcrunVersion) {
            return new OracleRun(true, true, false, false, false,
                    -1, -1, "", "",
                    0,
                    message == null || message.isBlank()
                            ? "I/O error while preparing or running the oracle"
                            : message,
                    moduleName, cobcVersion, cobcrunVersion);
        }

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("mode", "cobol-runtime");
            map.put("attempted", attempted);
            map.put("available", available);
            map.put("compileOk", compileOk);
            map.put("ran", ran);
            map.put("runOk", runOk);
            map.put("compileExitCode", compileExitCode);
            map.put("exitCode", exitCode);
            map.put("stdout", stdout == null ? "" : stdout);
            map.put("stderr", stderr == null ? "" : stderr);
            map.put("stdoutSha256", HashUtil.sha256(stdout == null ? "" : stdout));
            map.put("durationMs", durationMs);
            map.put("reason", reason == null ? "" : reason);
            map.put("moduleName", moduleName == null ? "" : moduleName);
            map.put("compiler", "cobc");
            map.put("runtime", "cobcrun");
            map.put("cobcVersion", cobcVersion == null ? "" : cobcVersion);
            map.put("cobcrunVersion", cobcrunVersion == null ? "" : cobcrunVersion);
            return map;
        }
    }

    private record CommandResult(int exitCode, String stdout, String stderr,
                                 long durationMs, String reason) {
    }

    private record VersionResult(int exitCode, String stdoutFirstLine, String stderrFirstLine) {
        String firstLine() {
            return stdoutFirstLine == null || stdoutFirstLine.isBlank()
                    ? stderrFirstLine
                    : stdoutFirstLine;
        }
    }
}
