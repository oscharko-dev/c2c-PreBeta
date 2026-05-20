package com.c2c.w0.buildtest;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Executes a compiled generated program inside an isolated classloader on a
 * dedicated worker thread.
 * <p>
 * Stdout and stderr written by the generated {@code main} method are captured
 * and returned. The thread is interrupted and stopped after a configurable
 * timeout to avoid runaway programs blocking the runner.
 * <p>
 * The runner does NOT shell out — it loads classes from the on-disk class
 * output directory using a child {@link URLClassLoader}. The generated code
 * runs inside the same JVM with parent classloader access so the runtime
 * dependency ({@code c2c-target-java-runtime}) is reachable.
 */
final class GeneratedProgramRunner {

    private GeneratedProgramRunner() {
    }

    static RunResult run(Path classOutputDir, String entryClass, long timeoutMs) {
        if (entryClass == null || entryClass.isBlank()) {
            return RunResult.skipped("missing-entry-class",
                    "entryClass is required to execute the generated program");
        }
        URL[] urls;
        try {
            urls = new URL[]{classOutputDir.toUri().toURL()};
        } catch (Exception e) {
            return RunResult.runError("classpath-build", e);
        }
        try (URLClassLoader loader = new URLClassLoader(urls,
                GeneratedProgramRunner.class.getClassLoader())) {
            Class<?> mainClass;
            try {
                mainClass = Class.forName(entryClass, true, loader);
            } catch (ClassNotFoundException e) {
                return RunResult.runError("entry-class-not-found",
                        new RuntimeException("Generated entry class not found: " + entryClass, e));
            }
            Method main;
            try {
                main = mainClass.getMethod("main", String[].class);
            } catch (NoSuchMethodException e) {
                return RunResult.runError("entry-main-missing",
                        new RuntimeException("Generated entry class has no main(String[]) method", e));
            }
            return invokeWithCapture(main, timeoutMs);
        } catch (Exception e) {
            return RunResult.runError("classloader", e);
        }
    }

    private static RunResult invokeWithCapture(Method main, long timeoutMs) {
        ByteArrayOutputStream stdoutCapture = new ByteArrayOutputStream();
        ByteArrayOutputStream stderrCapture = new ByteArrayOutputStream();
        // PrintStream wraps the in-memory ByteArrayOutputStream and owns no
        // OS resources, but it is still AutoCloseable. try-with-resources
        // guarantees flush+close even on exceptional paths and silences the
        // Qodana "AutoCloseable used without 'try'-with-resources" warning.
        try (PrintStream stdoutStream = new PrintStream(stdoutCapture, true, StandardCharsets.UTF_8);
             PrintStream stderrStream = new PrintStream(stderrCapture, true, StandardCharsets.UTF_8)) {
            try (ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(r -> {
                Thread t = new Thread(r, "c2c-build-test-runner");
                t.setDaemon(true);
                return t;
            })) {
                long started = System.nanoTime();
                Future<?> task = executor.submit(() -> {
                    PrintStream originalOut = System.out;
                    PrintStream originalErr = System.err;
                    System.setOut(stdoutStream);
                    System.setErr(stderrStream);
                    try {
                        main.invoke(null, (Object) new String[0]);
                    } catch (InvocationTargetException e) {
                        Throwable cause = e.getCause() == null ? e : e.getCause();
                        cause.printStackTrace(stderrStream);
                        throw new RuntimeException(cause);
                    } catch (IllegalAccessException e) {
                        e.printStackTrace(stderrStream);
                        throw new RuntimeException(e);
                    } finally {
                        System.setOut(originalOut);
                        System.setErr(originalErr);
                    }
                });
                try {
                    task.get(timeoutMs, TimeUnit.MILLISECONDS);
                    long elapsed = (System.nanoTime() - started) / 1_000_000L;
                    return RunResult.success(stdoutCapture.toString(StandardCharsets.UTF_8),
                            stderrCapture.toString(StandardCharsets.UTF_8), elapsed);
                } catch (TimeoutException e) {
                    task.cancel(true);
                    return RunResult.timeout(timeoutMs,
                            stdoutCapture.toString(StandardCharsets.UTF_8),
                            stderrCapture.toString(StandardCharsets.UTF_8));
                } catch (ExecutionException e) {
                    Throwable cause = e.getCause() == null ? e : e.getCause();
                    return RunResult.runtimeFailure(cause,
                            stdoutCapture.toString(StandardCharsets.UTF_8),
                            stderrCapture.toString(StandardCharsets.UTF_8));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return RunResult.runError("interrupted", e);
                } finally {
                    executor.shutdownNow();
                }
            }
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
            if (value == null) {
                return "";
            }
            return value.replace("\r\n", "\n").trim();
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
            if (stderr != null && !stderr.isBlank()) {
                if (log.length() > 0) {
                    log.append(" | ");
                }
                log.append("stderr-bytes=").append(HashUtil.byteLength(stderr));
            }
            if (stdout != null && !stdout.isBlank()) {
                if (log.length() > 0) {
                    log.append(" | ");
                }
                log.append("stdout-bytes=").append(HashUtil.byteLength(stdout));
            }
            return log.toString();
        }

        private static String safeRuntimeSummary(Throwable cause) {
            if (cause == null) {
                return "Generated program failed with an unknown runtime exception.";
            }
            String className = cause.getClass().getName();
            String message = cause.getMessage();
            if (message == null || message.isBlank()) {
                return "Generated program failed with " + className + ".";
            }
            return "Generated program failed with " + className + ": " + message.trim();
        }
    }
}
