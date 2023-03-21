const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { PptxExtractor } = require('pptx-extractor');
const ffmpeg = require('fluent-ffmpeg');
const tmp = require('tmp');

const tmpFileAsync = promisify(tmp.file);

async function generateRichCardsMp4(pptFilePath) {
  // Extract PPTX data
  const extractor = new PptxExtractor(pptFilePath);
  const slidesData = await extractor.extractAllSlidesData();

  // Get input path and output path
  const inputPath = path.dirname(pptFilePath);
  const outputPath = path.join(inputPath, path.basename(pptFilePath, '.pptx') + '.mp4');

  // Convert slides data to rich card JSON
  const richCards = slidesData.map((slideData) => ({
    title: slideData.title,
    image: path.join(inputPath, slideData.fileName),
    notes: slideData.notes,
  }));

  // Save slide images and notes audio
  const pngFiles = [];
  const wavFiles = [];
  for (let i = 0; i < slidesData.length; i++) {
    const slideData = slidesData[i];
    const pngFilePath = path.join(inputPath, slideData.fileName);
    const wavFilePath = await generateSlideNotesAudio(slideData.notes, inputPath, i);
    pngFiles.push(pngFilePath);
    wavFiles.push(wavFilePath);
  }

  // Create temporary directory for PNG and WAV files
  const tmpDirPath = await promisify(fs.mkdtemp)(path.join(inputPath, 'tmp-'));

  // Copy PNG and WAV files to temporary directory
  const tmpPngFiles = await Promise.all(pngFiles.map((pngFilePath) => promisify(fs.copyFile)(pngFilePath, path.join(tmpDirPath, path.basename(pngFilePath)))));
  const tmpWavFiles = await Promise.all(wavFiles.map((wavFilePath) => promisify(fs.copyFile)(wavFilePath, path.join(tmpDirPath, path.basename(wavFilePath)))));

  // Combine PNG and WAV files into MP4 video
  const tmpMp4File = await tmpFileAsync({ postfix: '.mp4' });
  await new Promise((resolve, reject) => {
    ffmpeg()
      .addInput(path.join(tmpDirPath, '%d.png'))
      .addInput(path.join(tmpDirPath, '%d.wav'))
      .addOutput(tmpMp4File)
      .withVideoCodec('libx264')
      .withAudioCodec('aac')
      .outputOptions('-pix_fmt', 'yuv420p')
      .on('end', () => {
        resolve();
      })
      .on('error', (error) => {
        reject(error);
      })
      .run();
  });

  // Copy MP4 file to output path
  await promisify(fs.copyFile)(tmpMp4File, outputPath);

  // Cleanup temporary files
  await Promise.all([
    ...tmpPngFiles.map((tmpPngFile) => promisify(fs.unlink)(tmpPngFile)),
    ...tmpWavFiles.map((tmpWavFile) => promisify(fs.unlink)(tmpWavFile)),
    promisify(fs.unlink)(tmpMp4File),
    promisify(fs.rmdir)(tmpDirPath),
  ]);
}

async function generateSlideNotesAudio(notes, outputPath, slideIndex) {
  const tmpFilePath = await tmpFileAsync({ postfix: '.wav' });
  return new Promise((resolve, reject) => {
    const synth = window.speechSynthesis;
    const utterance = new SpeechSynthesisUtterance(notes);
    utterance.onend = () => {
      const writeStream = fs.createWriteStream(tmpFilePath);
      const audioData = new Blob([new Uint8Array(writeStream._writableState.buffer)], { type: 'audio/wav' });
      const url = URL.createObjectURL(audioData);
      const audio = new Audio(url);
      audio.onloadedmetadata = () => {
        const duration = Math.ceil(audio.duration);
        const ffmpegCommand = ffmpeg()
          .input(url)
          .output(tmpFilePath)
          .outputOptions('-t', duration.toString())
          .on('end', () => {
            resolve(tmpFilePath);
          })
          .on('error', (error) => {
            reject(error);
          });
        ffmpegCommand.run();
      };
    };
    synth.speak(utterance);
  });
}

