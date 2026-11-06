# Sourced by Dockerfile RUN steps that use the network. If the build was given a CA as a BuildKit secret,
# as a host behind TLS inspection must, these steps trust it. The secret and these variables last only
# for that one step, and this file stays in the install stage, so the image can't inherit any of it.
if [ -s /run/secrets/build_ca ]; then
    export SSL_CERT_FILE=/run/secrets/build_ca REQUESTS_CA_BUNDLE=/run/secrets/build_ca \
        NODE_EXTRA_CA_CERTS=/run/secrets/build_ca CURL_CA_BUNDLE=/run/secrets/build_ca \
        GIT_SSL_CAINFO=/run/secrets/build_ca UV_NATIVE_TLS=1
fi
