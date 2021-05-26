let turn = 'black';

$('.ghost').on('click', evt => {
  let idx = evt.target.id;
  if ($(`#${idx}`).hasClass('ghost')) {
    $(`#${idx}`).removeClass('ghost').addClass(turn);
    turn = (turn === 'black') ? 'white' : 'black';
    $('#indicator').text(`${turn.charAt(0).toUpperCase() + turn.slice(1)} Stone`);
  }
});