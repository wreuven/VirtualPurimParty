#!/usr/bin/env python3
"""Detect face in image and output tight crop coordinates as JSON."""
import sys, json
import cv2
import numpy as np

def detect_face(image_path):
    img = cv2.imread(image_path)
    if img is None:
        return None
    h, w = img.shape[:2]

    # Use OpenCV DNN face detector (Caffe model)
    model_path = cv2.data.haarcascades  # just for path reference
    # Try DNN first, fall back to Haar
    face = None

    # Haar cascade (reliable, built-in)
    cascade = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_frontalface_default.xml')
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    faces = cascade.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(20, 20))

    if len(faces) == 0:
        # Try profile face
        profile = cv2.CascadeClassifier(cv2.data.haarcascades + 'haarcascade_profileface.xml')
        faces = profile.detectMultiScale(gray, scaleFactor=1.05, minNeighbors=3, minSize=(20, 20))

    if len(faces) == 0:
        return None

    # Pick largest face
    faces = sorted(faces, key=lambda f: f[2] * f[3], reverse=True)
    fx, fy, fw, fh = faces[0]

    # Add padding (20% around the face)
    pad = int(max(fw, fh) * 0.20)
    # Make square
    side = max(fw, fh) + pad * 2
    cx = fx + fw // 2
    cy = fy + fh // 2
    x1 = max(0, cx - side // 2)
    y1 = max(0, cy - side // 2)
    x2 = min(w, x1 + side)
    y2 = min(h, y1 + side)
    # Re-adjust to keep square
    side = min(x2 - x1, y2 - y1)
    x2 = x1 + side
    y2 = y1 + side

    return {"x": int(x1), "y": int(y1), "w": int(side), "h": int(side)}

if __name__ == "__main__":
    result = detect_face(sys.argv[1])
    if result:
        print(json.dumps(result))
    else:
        print(json.dumps(None))
