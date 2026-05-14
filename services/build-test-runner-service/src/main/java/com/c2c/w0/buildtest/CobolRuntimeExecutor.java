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

/**
 * Reproduces registry entries marked as true Golden Masters with GnuCOBOL.
 * Only checked-in corpus sources are eligible; request-provided source paths
 * cannot escape the repository corpus directory.
 */
final class CobolRuntimeExecutor {

    private static final long DEFAULT_TIMEOUT_MS = Duration.ofSeconds(10).toMillis();

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
