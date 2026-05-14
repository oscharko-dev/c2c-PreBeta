FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /workspace
# Install the runtime first so the service can depend on it.
COPY libs/c2c-target-java-runtime /workspace/libs/c2c-target-java-runtime
RUN cd /workspace/libs/c2c-target-java-runtime && mvn -q -DskipTests install
COPY services/target-java-generation-service/pom.xml /workspace/services/target-java-generation-service/pom.xml
COPY services/target-java-generation-service/src /workspace/services/target-java-generation-service/src
RUN cd /workspace/services/target-java-generation-service && mvn -q -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /workspace/services/target-java-generation-service/target/target-java-generation-service-0.1.0.jar /app/app.jar
EXPOSE 8083
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
