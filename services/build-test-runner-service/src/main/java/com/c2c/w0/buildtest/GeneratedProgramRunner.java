package com.c2c.w0.buildtest;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

/**
 * Executes compiled generated Java in a forked JVM with a scrubbed environment.
 *
 * <p>The runner deliberately avoids loading generated classes into the service
 * JVM. That keeps service secrets, harness tokens, global system properties and
 * {@code System.exit(...)} side effects outside the generated program's process
 * boundary while preserving the deterministic stdout/stderr contract.
 */
final class GeneratedProgramRunner {

    private static final int MAX_CAPTURE_BYTES = 1_048_576;
    private static final Pattern JVM_EXCEPTION_HEADER =
            Pattern.compile("^Exception in thread \\\"[^\\\"]+\\\" ([\\w.$]+)(?::\\s*(.*))?$");
    private static final Pattern JVM_CAUSED_BY_HEADER =
            Pattern.compile("^Caused by:\\s+([\\w.$]+)(?::\\s*(.*))?$");

    private GeneratedProgramRunner() {
    }

    static RunResult run(Path classOutputDir, String entryClass, long timeoutMs) {
        if (entryClass == null || entryClass.isBlank()) {
            return RunResult.skipped("missing-entry-class",
                    "entryClass is required to execute the generated program");
        }

        List<String> command = new ArrayList<>();
        command.add(javaBinary());
        command.add("-Djava.awt.headless=true");
        command.add("-Duser.language=en");
        command.add("-Duser.country=US");
        command.add("-Djava.io.tmpdir=" + classOutputDir.toAbsolutePath());
        command.add("-cp");
        command.add(classOutputDir.toAbsolutePath()
                + File.pathSeparator
                + System.getProperty("java.class.path", ""));
        command.add(entryClass);

        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(classOutputDir.toFile());
        Map<String, String> environment = builder.environment();
        environment.clear();
        environment.put("LANG", "C.UTF-8");
        environment.put("LC_ALL", "C.UTF-8");
        environment.put("TZ", "UTC");

        long started = System.nanoTime();
        Process process;
        try {
            process = builder.start();
        } catch (IOException e) {
            return RunResult.runError("process-start", e);
        }

        try (ExecutorService readers = Executors.newFixedThreadPool(2, runnable -> {
            Thread thread = new Thread(runnable, "c2c-generated-java-output-reader");
            thread.setDaemon(true);
            return thread;
        })) {
            Future<String> stdoutFuture = readers.submit(() -> readStream(process.getInputStream()));
            Future<String> stderrFuture = readers.submit(() -> readStream(process.getErrorStream()));

            boolean finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
            if (!finished) {
                process.destroy();
                if (!process.waitFor(250, TimeUnit.MILLISECONDS)) {
                    process.destroyForcibly();
                }
                long elapsed = (System.nanoTime() - started) / 1_000_000L;
                return RunResult.timeout(Math.max(timeoutMs, elapsed),
                        futureOutput(stdoutFuture),
                        futureOutput(stderrFuture));
            }

            int exitCode = process.exitValue();
            long elapsed = (System.nanoTime() - started) / 1_000_000L;
            String stdout = futureOutput(stdoutFuture);
            String stderr = futureOutput(stderrFuture);
            if (exitCode == 0) {
                return RunResult.success(stdout, stderr, elapsed);
            }
            return RunResult.processFailure(exitCode, stdout, stderr, elapsed);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            process.destroyForcibly();
            return RunResult.runError("interrupted", e);
        }
    }

    private static String javaBinary() {
        String javaHome = System.getProperty("java.home", "");
        if (!javaHome.isBlank()) {
            return javaHome + File.separator + "bin" + File.separator + "java";
        }
        return "java";
    }

    private static String readStream(InputStream stream) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int total = 0;
        int read;
        while ((read = stream.read(chunk)) != -1) {
            int remaining = MAX_CAPTURE_BYTES - buffer.size();
            if (remaining > 0) {
                buffer.write(chunk, 0, Math.min(read, remaining));
            }
            total += read;
        }
        if (total > MAX_CAPTURE_BYTES) {
            buffer.write(("\n[output truncated after " + MAX_CAPTURE_BYTES + " bytes]").getBytes(StandardCharsets.UTF_8));
        }
        return buffer.toString(StandardCharsets.UTF_8);
    }

    private static String futureOutput(Future<String> future) {
        try {
            return future.get(250, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return "";
        } catch (Exception e) {
            return "";
        }
    }

    record RunResult(boolean ran,
                     boolean ok,
                     int exitCode,
                     String stdout,
                     String stderr,
                     long durationMs,
                     String summary,
                     String errorClass,
                     String errorMessage) {

        Map<String, Object> toMap() {
            Map<String, Object> map = new LinkedHashMap<>();
            map.put("ran", ran);
            map.put("ok", ok);
            map.put("exitCode", exitCode);
            map.put("stdout", stdout);
            map.put("stderr", stderr);
            map.put("durationMs", durationMs);
            map.put("summary", summary);
            if (errorClass != null) {
                map.put("errorClass", errorClass);
            }
            if (errorMessage != null) {
                map.put("errorMessage", errorMessage);
            }
            map.put("stdoutRef", BuildTestRunnerService.outputReference("generated-java-stdout",
                    stdout == null ? "" : stdout));
            map.put("stderrRef", BuildTestRunnerService.outputReference("generated-java-stderr",
                    stderr == null ? "" : stderr));
            map.put("normalizedOutputRef", BuildTestRunnerService.outputReference("generated-java-normalized-output",
                    normalize(stdout)));
            map.put("logRef", BuildTestRunnerService.outputReference("generated-java-log",
                    buildLog(stdout, stderr, summary, errorClass, errorMessage)));
            map.put("evidenceRefs", List.of(
                    map.get("stdoutRef"),
                    map.get("stderrRef"),
                    map.get("normalizedOutputRef"),
                    map.get("logRef")));
            map.put("stdoutSha256", HashUtil.sha256(stdout == null ? "" : stdout));
            return map;
        }

        static RunResult success(String stdout, String stderr, long durationMs) {
            return new RunResult(true, true, 0, stdout, stderr, durationMs,
                    "Generated program completed successfully.",
                    null, null);
        }

        static RunResult timeout(long timeoutMs, String stdout, String stderr) {
            return new RunResult(true, false, 124, stdout, stderr, timeoutMs,
                    "Generated program exceeded " + timeoutMs + "ms wall-clock budget.",
                    "timeout",
                    "Generated program exceeded " + timeoutMs + "ms wall-clock budget");
        }

        static RunResult processFailure(int exitCode, String stdout, String stderr, long durationMs) {
            RuntimeFailureDetails runtimeFailure = runtimeFailureFrom(stderr);
            if (runtimeFailure != null) {
                return new RunResult(true, false, exitCode, stdout, stderr, durationMs,
                        runtimeFailure.summary(),
                        runtimeFailure.errorClass(),
                        runtimeFailure.errorMessage());
            }
            return new RunResult(true, false, exitCode, stdout, stderr, durationMs,
                    "Generated program exited with status " + exitCode + ".",
                    "process-exit-" + exitCode,
                    firstLine(stderr));
        }

        static RunResult runtimeFailure(Throwable cause, String stdout, String stderr) {
            return new RunResult(true, false, 1, stdout, stderr, 0,
                    safeRuntimeSummary(cause),
                    cause.getClass().getName(),
                    cause.getMessage() == null ? cause.toString() : cause.getMessage());
        }

        static RunResult runError(String errorClass, Throwable cause) {
            return new RunResult(false, false, -1, "", "", 0,
                    "Execution could not start: " + errorClass,
                    errorClass,
                    cause == null ? errorClass : (cause.getMessage() == null ? cause.toString() : cause.getMessage()));
        }

        static RunResult skipped(String errorClass, String message) {
            return new RunResult(false, false, -1, "", "", 0,
                    message,
                    errorClass, message);
        }

        private static String normalize(String value) {
            return DeterministicComparisonPolicy.normalize(value);
        }

        private static String buildLog(String stdout, String stderr, String summary, String errorClass, String errorMessage) {
            StringBuilder log = new StringBuilder();
            if (summary != null && !summary.isBlank()) {
                log.append(summary.trim());
            }
            if (errorClass != null) {
                if (log.length() > 0) {
                    log.append(" | ");
                }
                log.append(errorClass);
            }
            if (errorMessage != null && !errorMessage.isBlank()) {
                if (log.length() > 0) {
                    log.append(" | ");
                }
                log.append(errorMessage.trim());
            }
            if (stdout != null && !stdout.isBlank()) {
                if (log.length() > 0) {
                    log.append("\n--- stdout ---\n");
                }
                log.append(stdout);
            }
            if (stderr != null && !stderr.isBlank()) {
                if (log.length() > 0) {
                    log.append("\n--- stderr ---\n");
                }
                log.append(stderr);
            }
            return log.toString();
        }

        private static String safeRuntimeSummary(Throwable cause) {
            String name = cause == null ? "unknown" : cause.getClass().getSimpleName();
            String message = cause == null || cause.getMessage() == null ? "" : cause.getMessage();
            return message.isBlank()
                    ? "Generated program failed at runtime: " + name
                    : "Generated program failed at runtime: " + name + ": " + message;
        }

        private static RuntimeFailureDetails runtimeFailureFrom(String stderr) {
            String header = firstLine(stderr);
            if (header.isBlank()) {
                return null;
            }
            Matcher matcher = JVM_EXCEPTION_HEADER.matcher(header);
            if (!matcher.matches()) {
                matcher = JVM_CAUSED_BY_HEADER.matcher(header);
                if (!matcher.matches()) {
                    return null;
                }
            }
            String className = matcher.group(1);
            String message = matcher.groupCount() >= 2 ? matcher.group(2) : null;
            String safeMessage = message == null ? "" : message.trim();
            String simpleName = simpleClassName(className);
            String summary = safeMessage.isBlank()
                    ? "Generated program failed at runtime: " + simpleName
                    : "Generated program failed at runtime: " + simpleName + ": " + safeMessage;
            String errorMessage = safeMessage.isBlank() ? header : safeMessage;
            return new RuntimeFailureDetails(className, errorMessage, summary);
        }

        private static String simpleClassName(String className) {
            if (className == null || className.isBlank()) {
                return "unknown";
            }
            int packageSeparator = className.lastIndexOf('.');
            int nestedSeparator = className.lastIndexOf('$');
            int separator = Math.max(packageSeparator, nestedSeparator);
            return separator >= 0 ? className.substring(separator + 1) : className;
        }

        private static String firstLine(String value) {
            if (value == null || value.isBlank()) {
                return "";
            }
            int newline = value.indexOf('\n');
            return (newline >= 0 ? value.substring(0, newline) : value).trim();
        }

        private record RuntimeFailureDetails(String errorClass, String errorMessage, String summary) {
        }
    }
}
