package telemetry

import (
	"context"
	"errors"
	"os"
	"strings"

	"go.opentelemetry.io/contrib/exporters/autoexport"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.34.0"
)

// Start configures OTLP export when an operator has supplied an exporter or
// collector endpoint. With no telemetry environment, the runner stays quiet.
func Start(ctx context.Context) (func(context.Context) error, error) {
	if !configured() {
		return func(context.Context) error { return nil }, nil
	}

	res, err := resource.New(ctx,
		resource.WithFromEnv(),
		resource.WithProcess(),
		resource.WithTelemetrySDK(),
		resource.WithAttributes(semconv.ServiceName("dsh-runner")),
	)
	if err != nil {
		return nil, err
	}
	spanExporter, err := autoexport.NewSpanExporter(ctx)
	if err != nil {
		return nil, err
	}
	metricReader, err := autoexport.NewMetricReader(ctx)
	if err != nil {
		_ = spanExporter.Shutdown(ctx)
		return nil, err
	}

	traces := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(spanExporter),
		sdktrace.WithResource(res),
	)
	metrics := sdkmetric.NewMeterProvider(
		sdkmetric.WithReader(metricReader),
		sdkmetric.WithResource(res),
	)
	otel.SetTracerProvider(traces)
	otel.SetMeterProvider(metrics)
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return func(ctx context.Context) error {
		return errors.Join(traces.Shutdown(ctx), metrics.Shutdown(ctx))
	}, nil
}

func configured() bool {
	if strings.EqualFold(os.Getenv("OTEL_SDK_DISABLED"), "true") {
		return false
	}
	for _, name := range []string{
		"OTEL_EXPORTER_OTLP_ENDPOINT",
		"OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
		"OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
		"OTEL_TRACES_EXPORTER",
		"OTEL_METRICS_EXPORTER",
	} {
		if os.Getenv(name) != "" {
			return true
		}
	}
	return false
}
