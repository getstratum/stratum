"""A small tool-using agent that talks to Claude through a Stratum gateway.

The only Stratum-specific parts are the base URL (the gateway) and the API
key (a Stratum key, not an Anthropic one): the gateway checks the key and the
team's policy, then calls Anthropic with the organisation's provider key.

    pip install anthropic
    $env:STRATUM_KEY = "aig_sk_..."          # PowerShell
    python deploy/hybrid/pc/agent.py "¿Qué hora es y cuánto es 17 * 23?"

Optional: STRATUM_GATEWAY (default http://127.0.0.1:20128), MODEL (default
claude-haiku-4-5).
"""

import ast
import datetime
import operator
import os
import sys

import anthropic

GATEWAY = os.environ.get("STRATUM_GATEWAY", "http://127.0.0.1:20128")
client = anthropic.Anthropic(base_url=GATEWAY, api_key=os.environ["STRATUM_KEY"])

TOOLS = [
    {
        "name": "hora_actual",
        "description": "Devuelve la fecha y hora actual de esta máquina.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "calcular",
        "description": "Evalúa una expresión aritmética (+, -, *, /, **, paréntesis).",
        "input_schema": {
            "type": "object",
            "properties": {"expresion": {"type": "string"}},
            "required": ["expresion"],
        },
    },
]

_OPS = {
    ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
    ast.Div: operator.truediv, ast.Pow: operator.pow, ast.USub: operator.neg,
}


def _eval(node):
    # Arithmetic only: no names, calls or attributes.
    if isinstance(node, ast.Expression):
        return _eval(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.left), _eval(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _OPS:
        return _OPS[type(node.op)](_eval(node.operand))
    raise ValueError("expresión no permitida")


def run_tool(name, args):
    if name == "hora_actual":
        return datetime.datetime.now().isoformat(timespec="seconds")
    if name == "calcular":
        return str(_eval(ast.parse(args["expresion"], mode="eval")))
    return f"herramienta desconocida: {name}"


def pick_model():
    # The gateway proxies POST requests only, so the model list endpoint is
    # not available through it. Haiku is the cheapest model for a test.
    return os.environ.get("MODEL", "claude-haiku-4-5")


def main():
    prompt = " ".join(sys.argv[1:]) or "¿Qué hora es y cuánto es 17 * 23?"
    model = pick_model()
    print(f"gateway {GATEWAY} · model {model}\n> {prompt}\n")
    messages = [{"role": "user", "content": prompt}]
    for _ in range(5):
        try:
            resp = client.messages.create(model=model, max_tokens=512, tools=TOOLS, messages=messages)
        except anthropic.APIStatusError as e:
            # Errors from the gateway (401 key, 403 policy, 429 quota) carry its message.
            sys.exit(f"gateway answered {e.status_code}: {e.response.text}")
        messages.append({"role": "assistant", "content": resp.content})
        calls = [b for b in resp.content if b.type == "tool_use"]
        for b in resp.content:
            if b.type == "text" and b.text.strip():
                print(b.text)
        if not calls:
            print(f"\n[tokens in/out: {resp.usage.input_tokens}/{resp.usage.output_tokens}]")
            return
        results = []
        for c in calls:
            out = run_tool(c.name, c.input)
            print(f"  · {c.name}({c.input}) -> {out}")
            results.append({"type": "tool_result", "tool_use_id": c.id, "content": out})
        messages.append({"role": "user", "content": results})
    print("stopped after 5 turns")


if __name__ == "__main__":
    main()
