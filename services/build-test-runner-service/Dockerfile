FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace
# Install the runtime first so the service can depend on it.
COPY libs/c2c-target-java-runtime /workspace/libs/c2c-target-java-runtime
RUN cd /workspace/libs/c2c-target-java-runtime && mvn -q -DskipTests install
# target-java-generation-service is a test-scope dependency; install it so the
# build container can also run integration tests if invoked.
COPY services/target-java-generation-service /workspace/services/target-java-generation-service
RUN cd /workspace/services/target-java-generation-service && mvn -q -DskipTests install
COPY services/build-test-runner-service/pom.xml /workspace/services/build-test-runner-service/pom.xml
COPY services/build-test-runner-service/src /workspace/services/build-test-runner-service/src
RUN cd /workspace/services/build-test-runner-service && mvn -q -DskipTests package

# A JDK image is required at runtime: the service compiles generated Java
# in-memory using the JavaCompiler API, which is unavailable in JRE-only
# images.
FROM eclipse-temurin:21-jdk
WORKDIR /app
COPY --from=build /workspace/services/build-test-runner-service/target/build-test-runner-service-0.1.0.jar /app/app.jar
EXPOSE 8084
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
