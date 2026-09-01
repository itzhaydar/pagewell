/*
 * On-Device-OCR-PDF pipeline
 *
 * 1. Read one local image file; never send it anywhere.
 * 2. Decode and optionally preprocess it in a canvas
 *    (resize, grayscale, contrast).
 * 3. Lazy-load Tesseract.js only when OCR starts and run it
 *    in a Web Worker.
 * 4. Keep Tesseract's recognized text, word boxes, and confidence
 *    in browser memory.
 * 5. Use pdf-lib to create an A4 PDF:
 *       page image + nearly invisible selectable OCR text layer.
 *
 * The app deliberately has no backend, accounts, analytics,
 * API keys, or document uploads.
 */

(() => {
  'use strict';

  const CONFIG = Object.freeze({
    maxFileBytes: 20 * 1024 * 1024,
    maxImageWidth: 2000,
    maxImageHeight: 2800,

    pdfWidth: 595.28,
    pdfHeight: 841.89,
    pdfMargin: 28,

    tesseractScript:
      'https://cdn.jsdelivr.net/npm/tesseract.js@7.0.0/dist/tesseract.min.js'
  });

  const state = {
    file: null,
    originalUrl: null,
    image: null,
    canvas: null,
    rotatedDegrees: 0,
    enhanced: true,

    ocrData: null,

    worker: null,
    pdfBytes: null,

    busy: false,
    tesseractPromise: null
  };

  const $ = (id) => document.getElementById(id);

  const els = {
    dropZone: $('dropZone'),
    fileInput: $('fileInput'),
    message: $('message'),

    editorPanel: $('editorPanel'),
    resultPanel: $('resultPanel'),

    previewImage: $('previewImage'),
    fileName: $('fileName'),

    rotateBtn: $('rotateBtn'),
    enhanceToggle: $('enhanceToggle'),
    extractBtn: $('extractBtn'),
    startOverBtn: $('startOverBtn'),

    ocrProgress: $('ocrProgress'),
    ocrStatus: $('ocrStatus'),
    ocrPercent: $('ocrPercent'),
    progressBar: $('progressBar'),
    ocrDetail: $('ocrDetail'),

    textOutput: $('textOutput'),
    copyBtn: $('copyBtn'),
    downloadBtn: $('downloadBtn'),

    confidenceBadge: $('confidenceBadge'),
    pdfStatus: $('pdfStatus')
  };

  function setMessage(text, type = 'error') {
    els.message.textContent = text;

    els.message.className =
      `message${type === 'success' ? ' success' : ''}`;

    els.message.hidden = !text;
  }

  function clearMessage() {
    els.message.hidden = true;
    els.message.textContent = '';
  }

  function setProgress(progress, status, detail) {
    const safeProgress = Math.max(
      0,
      Math.min(100, Number(progress) || 0)
    );

    els.ocrStatus.textContent = status;
    els.ocrPercent.textContent = `${Math.round(safeProgress)}%`;
    els.progressBar.style.width = `${safeProgress}%`;
    els.ocrDetail.textContent = detail || '';
  }

  function setBusy(busy) {
    state.busy = busy;

    [
      els.extractBtn,
      els.rotateBtn,
      els.startOverBtn,
      els.enhanceToggle,
      els.copyBtn,
      els.downloadBtn
    ].forEach((button) => {
      button.disabled = busy;
    });

    els.dropZone.setAttribute(
      'aria-disabled',
      String(busy)
    );
  }

  function isSupportedFile(file) {
    const accepted = [
      'image/jpeg',
      'image/png',
      'image/webp'
    ];

    const name = file.name.toLowerCase();

    return (
      accepted.includes(file.type) ||
      /\.(jpe?g|png|webp)$/.test(name)
    );
  }

  function validateFile(file) {
    if (!file) {
      return 'No image was selected.';
    }

    if (!isSupportedFile(file)) {
      return 'Unsupported file type. Please choose a JPG, JPEG, PNG, or WEBP image.';
    }

    if (file.size > CONFIG.maxFileBytes) {
      return 'That image is too large. Please choose a file under 20 MB so OCR can stay responsive.';
    }

    return '';
  }

  function readImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);

      const img = new Image();

      img.onload = () => {
        resolve({
          img,
          url
        });
      };

      img.onerror = () => {
        URL.revokeObjectURL(url);

        reject(
          new Error(
            'The selected image could not be decoded by this browser.'
          )
        );
      };

      img.src = url;
    });
  }

  function calculateCanvasSize(
    width,
    height,
    rotation
  ) {
    const rotated = rotation % 180 !== 0;

    const sourceWidth = rotated ? height : width;
    const sourceHeight = rotated ? width : height;

    const scale = Math.min(
      1,
      CONFIG.maxImageWidth / sourceWidth,
      CONFIG.maxImageHeight / sourceHeight
    );

    return {
      width: Math.max(
        1,
        Math.round(sourceWidth * scale)
      ),

      height: Math.max(
        1,
        Math.round(sourceHeight * scale)
      ),

      scale
    };
  }

  function buildProcessingCanvas(
    img,
    rotation,
    enhance
  ) {
    const size = calculateCanvasSize(
      img.naturalWidth,
      img.naturalHeight,
      rotation
    );

    const canvas = document.createElement('canvas');

    canvas.width = size.width;
    canvas.height = size.height;

    const ctx = canvas.getContext(
      '2d',
      {
        willReadFrequently: true
      }
    );

    if (!ctx) {
      throw new Error(
        'This browser could not create a canvas for image processing.'
      );
    }

    ctx.save();

    if (rotation === 90) {
      ctx.translate(canvas.width, 0);
      ctx.rotate(Math.PI / 2);
    } else if (rotation === 180) {
      ctx.translate(
        canvas.width,
        canvas.height
      );

      ctx.rotate(Math.PI);
    } else if (rotation === 270) {
      ctx.translate(0, canvas.height);
      ctx.rotate(-Math.PI / 2);
    }

    const drawWidth =
      rotation % 180 === 0
        ? canvas.width
        : canvas.height;

    const drawHeight =
      rotation % 180 === 0
        ? canvas.height
        : canvas.width;

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    ctx.drawImage(
      img,
      0,
      0,
      drawWidth,
      drawHeight
    );

    ctx.restore();

    if (!enhance) {
      return canvas;
    }

    const imageData = ctx.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    );

    const data = imageData.data;

    const contrast = 1.18;
    const midpoint = 128;

    for (let i = 0; i < data.length; i += 4) {
      const gray =
        0.299 * data[i] +
        0.587 * data[i + 1] +
        0.114 * data[i + 2];

      const adjusted = Math.max(
        0,
        Math.min(
          255,
          (gray - midpoint) *
            contrast +
            midpoint
        )
      );

      data[i] = adjusted;
      data[i + 1] = adjusted;
      data[i + 2] = adjusted;
    }

    ctx.putImageData(
      imageData,
      0,
      0
    );

    return canvas;
  }

  function updatePreview() {
    if (!state.image) {
      return;
    }

    state.enhanced =
      els.enhanceToggle.checked;

    state.canvas =
      buildProcessingCanvas(
        state.image,
        state.rotatedDegrees,
        state.enhanced
      );

    els.previewImage.src =
      state.canvas.toDataURL(
        'image/jpeg',
        0.9
      );

    state.ocrData = null;
    state.pdfBytes = null;

    els.resultPanel.hidden = true;
    els.pdfStatus.textContent = '';
  }

  async function handleFile(file) {
    if (state.busy) {
      return;
    }

    clearMessage();

    const error = validateFile(file);

    if (error) {
      setMessage(error);
      return;
    }

    try {
      if (state.originalUrl) {
        URL.revokeObjectURL(
          state.originalUrl
        );
      }

      const loaded =
        await readImage(file);

      state.file = file;
      state.image = loaded.img;
      state.originalUrl = loaded.url;

      state.rotatedDegrees = 0;
      state.ocrData = null;
      state.pdfBytes = null;

      els.fileName.textContent =
        file.name;

      els.enhanceToggle.checked = true;

      updatePreview();

      els.editorPanel.hidden = false;

      els.dropZone.scrollIntoView({
        behavior: 'smooth',
        block: 'start'
      });

    } catch (error) {
      setMessage(
        error.message ||
        'Could not load that image.'
      );
    }
  }

  function loadScript(src) {
    if (window.Tesseract) {
      return Promise.resolve(
        window.Tesseract
      );
    }

    if (state.tesseractPromise) {
      return state.tesseractPromise;
    }

    state.tesseractPromise =
      new Promise(
        (resolve, reject) => {
          const existing =
            document.querySelector(
              'script[data-tesseract="true"]'
            );

          if (existing) {
            existing.addEventListener(
              'load',
              () => {
                resolve(
                  window.Tesseract
                );
              },
              { once: true }
            );

            existing.addEventListener(
              'error',
              () => {
                reject(
                  new Error(
                    'Tesseract.js could not be loaded.'
                  )
                );
              },
              { once: true }
            );

            return;
          }

          const script =
            document.createElement(
              'script'
            );

          script.src = src;
          script.async = true;
          script.dataset.tesseract = 'true';

          script.onload = () => {
            if (window.Tesseract) {
              resolve(
                window.Tesseract
              );
            } else {
              reject(
                new Error(
                  'Tesseract.js loaded but was not available.'
                )
              );
            }
          };

          script.onerror = () => {
            reject(
              new Error(
                'Tesseract.js could not be loaded. Check your internet connection or CDN access.'
              )
            );
          };

          document.head.appendChild(
            script
          );
        }
      );

    return state.tesseractPromise;
  }

  function confidenceFromWords(words) {
    const valid =
      (words || [])
        .map((word) =>
          Number(word.confidence)
        )
        .filter(Number.isFinite);

    if (!valid.length) {
      return null;
    }

    return (
      valid.reduce(
        (sum, value) =>
          sum + value,
        0
      ) / valid.length
    );
  }

  function normalizeWords(data) {
    if (!Array.isArray(data.words)) {
      return [];
    }

    return data.words
      .filter(
        (word) =>
          word &&
          word.text &&
          word.bbox
      )
      .map((word) => ({
        text: word.text,

        confidence:
          Number(word.confidence),

        bbox: {
          left:
            Number(word.bbox.x0),

          top:
            Number(word.bbox.y0),

          right:
            Number(word.bbox.x1),

          bottom:
            Number(word.bbox.y1)
        }
      }))
      .filter(
        (word) =>
          [
            word.bbox.left,
            word.bbox.top,
            word.bbox.right,
            word.bbox.bottom
          ].every(Number.isFinite)
      );
  }

  async function extractText() {
    if (
      state.busy ||
      !state.image
    ) {
      return;
    }

    setBusy(true);

    clearMessage();

    els.ocrProgress.hidden = false;
    els.resultPanel.hidden = true;

    setProgress(
      0,
      'Loading OCR engine…',
      'The first OCR run may download the English language model and can take a while.'
    );

    try {
      state.enhanced =
        els.enhanceToggle.checked;

      state.canvas =
        buildProcessingCanvas(
          state.image,
          state.rotatedDegrees,
          state.enhanced
        );

      const tesseract =
        await loadScript(
          CONFIG.tesseractScript
        );

      setProgress(
        8,
        'Starting OCR…',
        'Your image remains in this browser tab.'
      );

      state.worker =
        await tesseract.createWorker(
          'eng',
          1,
          {
            logger: (event) => {
              const progress =
                Number.isFinite(
                  event.progress
                )
                  ? event.progress
                  : 0;

              const pct =
                10 +
                progress * 82;

              const status =
                event.status
                  ? event.status.replace(
                      /_/g,
                      ' '
                    )
                  : 'Recognizing text';

              const cleanStatus =
                status
                  .charAt(0)
                  .toUpperCase() +
                status.slice(1);

              setProgress(
                pct,
                cleanStatus,
                'Tesseract is processing the page locally.'
              );
            }
          }
        );

      const result =
        await state.worker.recognize(
          state.canvas
        );

      const data =
        result &&
        result.data
          ? result.data
          : {};

      const text =
        typeof data.text === 'string'
          ? data.text.trim()
          : '';

      const words =
        normalizeWords(data);

      const confidence =
        confidenceFromWords(
          words
        ) ??
        (
          Number.isFinite(
            Number(data.confidence)
          )
            ? Number(data.confidence)
            : null
        );

      state.ocrData = {
        text,
        words,
        confidence,

        imageWidth:
          state.canvas.width,

        imageHeight:
          state.canvas.height
      };

      els.textOutput.value =
        text;

      renderConfidence(
        confidence
      );

      els.resultPanel.hidden =
        false;

      setProgress(
        100,
        'OCR complete',
        text
          ? 'You can edit the extracted text, copy it, or create a searchable PDF.'
          : 'No readable text was detected. Try a clearer, better-lit printed page.'
      );

      if (!text) {
        setMessage(
          'OCR completed, but no readable text was detected. Try a sharper photo or turn on “Enhance for OCR”.'
        );
      }

    } catch (error) {
      console.error(error);

      setProgress(
        0,
        'OCR failed',
        ''
      );

      const reason =
        error &&
        error.message
          ? error.message
          : 'Unknown OCR error.';

      setMessage(
        `OCR could not run. ${reason} If you are offline or the CDN is blocked, load the app with internet access or vendor the Tesseract files locally.`
      );

    } finally {
      if (state.worker) {
        try {
          await state.worker.terminate();
        } catch (error) {
          console.warn(
            'Worker cleanup failed',
            error
          );
        }

        state.worker = null;
      }

      setBusy(false);
    }
  }

  function renderConfidence(
    confidence
  ) {
    if (
      !Number.isFinite(
        confidence
      )
    ) {
      els.confidenceBadge.hidden =
        true;

      els.confidenceBadge.textContent =
        '';

      return;
    }

    els.confidenceBadge.hidden =
      false;

    els.confidenceBadge.textContent =
      `OCR confidence ${Math.round(
        confidence
      )}%`;
  }

  async function copyText() {
    const text =
      els.textOutput.value;

    if (!text) {
      setMessage(
        'There is no extracted text to copy yet.'
      );

      return;
    }

    try {
      await navigator.clipboard.writeText(
        text
      );

      setMessage(
        'Text copied to your clipboard.',
        'success'
      );

    } catch (error) {
      els.textOutput.focus();
      els.textOutput.select();

      setMessage(
        'Clipboard access was blocked. The text is selected so you can copy it manually.'
      );
    }
  }

  function sanitizeFilename(name) {
    const base =
      (name || 'page')
        .replace(
          /\.[^.]+$/,
          ''
        )
        .replace(
          /[^a-z0-9_-]+/gi,
          '-'
        )
        .replace(
          /^-+|-+$/g,
          ''
        )
        .slice(0, 80);

    return (
      base ||
      'pagewell-document'
    );
  }

  function drawImageFitted(
    page,
    image,
    imageWidth,
    imageHeight
  ) {
    const margin =
      CONFIG.pdfMargin;

    const maxWidth =
      CONFIG.pdfWidth -
      margin * 2;

    const maxHeight =
      CONFIG.pdfHeight -
      margin * 2;

    const scale =
      Math.min(
        maxWidth / imageWidth,
        maxHeight / imageHeight
      );

    const drawWidth =
      imageWidth * scale;

    const drawHeight =
      imageHeight * scale;

    const x =
      (CONFIG.pdfWidth -
        drawWidth) / 2;

    const y =
      (CONFIG.pdfHeight -
        drawHeight) / 2;

    page.drawImage(
      image,
      {
        x,
        y,
        width: drawWidth,
        height: drawHeight
      }
    );

    return {
      x,
      y,
      width: drawWidth,
      height: drawHeight,
      scale
    };
  }

  function drawSearchableTextLayer(
    page,
    words,
    imageWidth,
    imageHeight,
    placement,
    font
  ) {
    if (!words.length) {
      return 0;
    }

    let placed = 0;

    const sx =
      placement.width /
      imageWidth;

    const sy =
      placement.height /
      imageHeight;

    for (const word of words) {
      const box =
        word.bbox;

      const widthPx =
        Math.max(
          1,
          box.right -
            box.left
        );

      const heightPx =
        Math.max(
          1,
          box.bottom -
            box.top
        );

      const x =
        placement.x +
        box.left * sx;

      const width =
        widthPx * sx;

      const height =
        heightPx * sy;

      const fontSize =
        Math.max(
          5,
          Math.min(
            42,
            height * .92
          )
        );

      const y =
        placement.y +
        placement.height -
        box.bottom * sy +
        Math.max(
          0,
          (height - fontSize) *
            .18
        );

      const text =
        word.text.trim();

      if (!text) {
        continue;
      }

      /*
       * Keep the OCR layer visually unobtrusive while
       * retaining selectable/searchable text.
       */
      page.drawText(
        text,
        {
          x,
          y,
          size: fontSize,
          font,

          color:
            PDFLib.rgb(
              1,
              1,
              1
            ),

          opacity: 0.01,

          maxWidth:
            Math.max(
              width * 1.35,
              4
            ),

          wordBreaks: [' ']
        }
      );

      placed += 1;
    }

    return placed;
  }

  async function createPdf() {
    if (
      state.busy ||
      !state.canvas ||
      !state.ocrData
    ) {
      return;
    }

    if (!window.PDFLib) {
      setMessage(
        'The PDF library could not be loaded. Check your internet connection or CDN access.'
      );

      return;
    }

    setBusy(true);

    els.downloadBtn.disabled =
      true;

    els.pdfStatus.textContent =
      'Building your searchable PDF…';

    clearMessage();

    try {
      const {
        PDFDocument,
        StandardFonts
      } = PDFLib;

      const pdfDoc =
        await PDFDocument.create();

      pdfDoc.setTitle(
        'On-Device-OCR-PDF document'
      );

      pdfDoc.setCreator(
        'On-Device-OCR-PDF'
      );

      const page =
        pdfDoc.addPage([
          CONFIG.pdfWidth,
          CONFIG.pdfHeight
        ]);

      const imageBytes =
        dataUrlToBytes(
          state.canvas.toDataURL(
            'image/jpeg',
            .9
          )
        );

      const embedded =
        await pdfDoc.embedJpg(
          imageBytes
        );

      const placement =
        drawImageFitted(
          page,
          embedded,
          state.canvas.width,
          state.canvas.height
        );

      const font =
        await pdfDoc.embedFont(
          StandardFonts.Helvetica
        );

      const placed =
        drawSearchableTextLayer(
          page,
          state.ocrData.words,
          state.ocrData.imageWidth,
          state.ocrData.imageHeight,
          placement,
          font
        );

      /*
       * The textarea is editable, but the PDF text layer intentionally
       * uses the original OCR word boxes. This prevents edited text from
       * being falsely positioned as though Tesseract recognized it there.
       */

      state.pdfBytes =
        await pdfDoc.save();

      const baseName =
        sanitizeFilename(
          state.file?.name
        );

      const date =
        new Date()
          .toISOString()
          .slice(0, 10);

      const filename =
        `${baseName || 'pagewell'}-${date}.pdf`;

      downloadBlob(
        new Blob(
          [state.pdfBytes],
          {
            type: 'application/pdf'
          }
        ),
        filename
      );

      els.pdfStatus.textContent =
        placed
          ? `PDF ready. ${placed} OCR word boxes were added as a searchable text layer.`
          : 'PDF ready. Tesseract did not provide word boxes, so this PDF contains the page image without a searchable layer.';

    } catch (error) {
      console.error(error);

      state.pdfBytes = null;
      els.pdfStatus.textContent = '';

      setMessage(
        `PDF generation failed. ${error.message || 'Please try again with the same or a smaller image.'}`
      );

    } finally {
      setBusy(false);
    }
  }

  function dataUrlToBytes(dataUrl) {
    const base64 =
      dataUrl.split(',')[1];

    const binary =
      atob(base64);

    const bytes =
      new Uint8Array(
        binary.length
      );

    for (
      let i = 0;
      i < binary.length;
      i += 1
    ) {
      bytes[i] =
        binary.charCodeAt(i);
    }

    return bytes;
  }

  function downloadBlob(
    blob,
    filename
  ) {
    const url =
      URL.createObjectURL(
        blob
      );

    const anchor =
      document.createElement(
        'a'
      );

    anchor.href = url;
    anchor.download =
      filename;

    document.body.appendChild(
      anchor
    );

    anchor.click();

    anchor.remove();

    setTimeout(
      () =>
        URL.revokeObjectURL(
          url
        ),
      1000
    );
  }

  async function startOver() {
    if (state.busy) {
      return;
    }

    if (state.worker) {
      try {
        await state.worker.terminate();
      } catch (error) {
        console.warn(error);
      }
    }

    if (state.originalUrl) {
      URL.revokeObjectURL(
        state.originalUrl
      );
    }

    state.file = null;
    state.originalUrl = null;
    state.image = null;
    state.canvas = null;
    state.rotatedDegrees = 0;
    state.ocrData = null;
    state.pdfBytes = null;
    state.worker = null;

    els.fileInput.value = '';

    els.previewImage.removeAttribute(
      'src'
    );

    els.fileName.textContent =
      'image.jpg';

    els.textOutput.value = '';

    els.confidenceBadge.hidden =
      true;

    els.confidenceBadge.textContent =
      '';

    els.ocrProgress.hidden =
      true;

    els.resultPanel.hidden =
      true;

    els.editorPanel.hidden =
      true;

    els.pdfStatus.textContent =
      '';

    clearMessage();

    window.scrollTo({
      top: 0,
      behavior: 'smooth'
    });
  }

  function rotateImage() {
    if (
      state.busy ||
      !state.image
    ) {
      return;
    }

    state.rotatedDegrees =
      (
        state.rotatedDegrees +
        90
      ) % 360;

    updatePreview();
  }

  function onDrop(event) {
    event.preventDefault();

    els.dropZone.classList.remove(
      'is-dragging'
    );

    if (state.busy) {
      return;
    }

    const file =
      event.dataTransfer.files &&
      event.dataTransfer.files[0];

    if (file) {
      handleFile(file);
    }
  }

  /* Upload */

  els.dropZone.addEventListener(
    'click',
    () => {
      if (!state.busy) {
        els.fileInput.click();
      }
    }
  );

  els.dropZone.addEventListener(
    'keydown',
    (event) => {
      if (state.busy) {
        return;
      }

      if (
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        event.preventDefault();
        els.fileInput.click();
      }
    }
  );

  els.dropZone.addEventListener(
    'dragover',
    (event) => {
      event.preventDefault();

      if (!state.busy) {
        els.dropZone.classList.add(
          'is-dragging'
        );
      }
    }
  );

  els.dropZone.addEventListener(
    'dragleave',
    () => {
      els.dropZone.classList.remove(
        'is-dragging'
      );
    }
  );

  els.dropZone.addEventListener(
    'drop',
    onDrop
  );

  els.fileInput.addEventListener(
    'change',
    (event) => {
      handleFile(
        event.target.files[0]
      );
    }
  );

  /* Image controls */

  els.enhanceToggle.addEventListener(
    'change',
    updatePreview
  );

  els.rotateBtn.addEventListener(
    'click',
    rotateImage
  );

  /* OCR */

  els.extractBtn.addEventListener(
    'click',
    extractText
  );

  /* Results */

  els.copyBtn.addEventListener(
    'click',
    copyText
  );

  els.downloadBtn.addEventListener(
    'click',
    createPdf
  );

  els.startOverBtn.addEventListener(
    'click',
    startOver
  );

  /* Cleanup */

  window.addEventListener(
    'beforeunload',
    () => {
      if (state.originalUrl) {
        URL.revokeObjectURL(
          state.originalUrl
        );
      }

      if (state.worker) {
        state.worker
          .terminate()
          .catch(() => {});
      }
    }
  );
})();
