import { Howl } from 'howler';
var sound = new Howl({
  src: ['hello_world.wav'],
  onend: function() {
    console.log('Finished playing!');
  }
});
sound.play();