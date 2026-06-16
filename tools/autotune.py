#!/usr/bin/env python3
"""
Autonomous test loop for Stichai DST quality.

Usage: python3 tools/autotune.py [--api URL] [--input IMAGE]

Steps:
1. POST the cartoon image to /generate-embroidery
2. Poll until done
3. Download DST
4. Run dst_qa.py for metrics
5. Run render_dst.py viewer-mode render
6. Compare render to input image (visual diff / alignment check)
7. Report issues and suggest patches
"""
import argparse, json, os, subprocess, sys, time, urllib.request, urllib.parse

API = os.getenv("STICHAI_API", "https://stichai-bot-stichai.up.railway.app")
INPUT_IMG = os.getenv("STICHAI_INPUT", "/data/data/com.termux/files/home/.openclaw/workspace/tmp/cartoon_subj.png")


def api_post(endpoint, data=None, files=None):
    url = f"{API}{endpoint}"
    if files:
        import mimetypes
        boundary = "----FormBoundary" + os.urandom(8).hex()
        body = b""
        for k, v in (data or {}).items():
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"\r\n\r\n{v}\r\n".encode()
        for k, (fname, fdata) in files.items():
            ct = mimetypes.guess_type(fname)[0] or "application/octet-stream"
            body += f"--{boundary}\r\nContent-Disposition: form-data; name=\"{k}\"; filename=\"{fname}\"\r\nContent-Type: {ct}\r\n\r\n".encode()
            body += fdata + b"\r\n"
        body += f"--{boundary}--\r\n".encode()
        req = urllib.request.Request(url, body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    else:
        req = urllib.request.Request(url, json.dumps(data or {}).encode(), headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())


def generate(job_id, img_path):
    with open(img_path, "rb") as f:
        img_data = f.read()
    r = api_post("/generate-embroidery",
        data={"jobId": job_id, "mode": "cartoon", "extractedSubject": "1"},
        files={"image": ("cartoon.png", img_data)})
    return r


def poll_by_id(job_id, max_wait=300):
    url = f"{API}/job-status/{job_id}"
    for _ in range(max_wait):
        with urllib.request.urlopen(url, timeout=30) as r:
            d = json.loads(r.read().decode())
        if d.get("status") in ("done", "failed"):
            return d
        time.sleep(2)
    return {"status": "timeout"}


def download_raw(job_id, out_path):
    # Try public /raw-dst endpoint first (no auth needed)
    url = f"{API}/raw-dst/{job_id}"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            with open(out_path, "wb") as f:
                f.write(r.read())
        return True
    except Exception:
        # Fallback: download ZIP from /download and extract
        url = f"{API}/download/{job_id}"
        zip_path = out_path + ".zip"
        with urllib.request.urlopen(url, timeout=30) as r:
            with open(zip_path, "wb") as f:
                f.write(r.read())
        import zipfile
        with zipfile.ZipFile(zip_path, "r") as z:
            members = [n for n in z.namelist() if n.endswith(".dst")]
            if members:
                z.extract(members[0], path=os.path.dirname(out_path))
                extracted = os.path.join(os.path.dirname(out_path), members[0])
                os.rename(extracted, out_path)
        os.remove(zip_path)
        return os.path.exists(out_path)


def qa(dst_path):
    r = subprocess.run(["python3", "tools/dst_qa.py", dst_path],
                        capture_output=True, text=True, cwd="/data/data/com.termux/files/home/stichai-bot")
    out = r.stdout + r.stderr
    metrics = {}
    for line in out.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            try:
                metrics[k.strip()] = float(v.strip())
            except ValueError:
                metrics[k.strip()] = v.strip()
    return metrics, out


def render(dst_path, out_png, ppmm=8):
    r = subprocess.run(["python3", "tools/render_dst.py", dst_path, out_png, str(ppmm), "viewer", "0"],
                        capture_output=True, text=True, cwd="/data/data/com.termux/files/home/stichai-bot")
    print(r.stdout.strip())
    return out_png


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default=API)
    ap.add_argument("--input", default=INPUT_IMG)
    ap.add_argument("--work-dir", default="/data/data/com.termux/files/home/.openclaw/workspace/tmp/autotune")
    ap.add_argument("--job-id", default=None)
    args = ap.parse_args()

    os.makedirs(args.work_dir, exist_ok=True)
    client_job_id = args.job_id or ("test_" + os.urandom(4).hex())
    
    print(f"[{client_job_id}] Generating from {args.input} …")
    r = generate(client_job_id, args.input)
    print(f"[{client_job_id}] POST -> id={r.get('id')} msg={r.get('message', r)}")
    api_id = r.get("id")
    if not api_id:
        print(f"[{client_job_id}] FAILED to get API job id")
        sys.exit(1)
    
    dst_path = os.path.join(args.work_dir, f"{api_id}.dst")
    png_path = os.path.join(args.work_dir, f"{api_id}.png")

    print(f"[{api_id}] Polling …")
    d = poll_by_id(api_id)
    if d.get("status") != "done":
        print(f"[{api_id}] FAILED:", d)
        sys.exit(1)

    ok = download_raw(api_id, dst_path)
    if not ok:
        print(f"[{api_id}] FAILED to download DST")
        sys.exit(1)
    print(f"[{api_id}] DST saved -> {dst_path} ({os.path.getsize(dst_path)} bytes)")

    metrics, raw = qa(dst_path)
    print(f"[{api_id}] QA metrics:")
    for k, v in sorted(metrics.items()):
        print(f"  {k} = {v}")

    render(dst_path, png_path)
    print(f"[{api_id}] Render -> {png_path}")

    # TODO: compare png_path against args.input and emit patch suggestions

if __name__ == "__main__":
    main()
