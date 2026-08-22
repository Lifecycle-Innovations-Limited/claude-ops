"""Loopback-only, health-gated local failover gateway."""

from .config import ConfigError, GatewayConfig, load_config, parse_config

__all__ = ["ConfigError", "GatewayConfig", "load_config", "parse_config"]
