import importlib.util
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("agent_loop.py")
SPEC = importlib.util.spec_from_file_location("agent_loop", MODULE_PATH)
assert SPEC and SPEC.loader
agent_loop = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = agent_loop
SPEC.loader.exec_module(agent_loop)


class AgentLoopTests(unittest.TestCase):
    def test_extracts_multiple_utf8_files(self):
        response = """[FILE: src/a.ts]
```ts
export const label = "히트맵";
```
[FILE: src/b.css]
```css
.dot { opacity: .5; }
```"""
        self.assertEqual(
            agent_loop.extract_file_changes(response),
            [
                ("src/a.ts", 'export const label = "히트맵";'),
                ("src/b.css", ".dot { opacity: .5; }"),
            ],
        )

    def test_rejects_traversal_before_writing(self):
        with self.assertRaises(agent_loop.AgentLoopError):
            agent_loop.apply_file_changes("[FILE: ../secret]\n```\nnope\n```")

    def test_missing_api_key_is_a_safe_status(self):
        with patch.dict(os.environ, {}, clear=True):
            client, status = agent_loop.build_client()
        self.assertIsNone(client)
        self.assertEqual(status, "OPENAI_API_KEY is not set")

    def test_missing_sdk_uses_no_install_http_fallback(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-only"}, clear=True):
            with patch.dict(sys.modules, {"openai": None}):
                client, status = agent_loop.build_client()
        self.assertIsNotNone(client)
        self.assertEqual(status, "ready (stdlib HTTPS fallback)")

    def test_apply_file_changes_writes_under_project_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch.object(agent_loop, "PROJECT_ROOT", root):
                changed = agent_loop.apply_file_changes(
                    "[FILE: src/generated.ts]\n```ts\nexport const ok = true;\n```"
                )
            self.assertEqual(changed[0].path, "src/generated.ts")
            self.assertEqual(
                (root / "src/generated.ts").read_text(encoding="utf-8"),
                "export const ok = true;",
            )

    def test_tail_is_limited_to_3000_characters(self):
        result = agent_loop.run_tests(
            command=[sys.executable, "-c", "print('x' * 5000)"], timeout_seconds=10
        )
        self.assertEqual(result.returncode, 0)
        self.assertLessEqual(len(result.output_tail), 3000)


if __name__ == "__main__":
    unittest.main()
